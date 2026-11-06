'use strict';

// Portable, offline importer for local project metadata. No network or auth access.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { digest, parseJson, writeAtomic, commitState } = require('./state-store.cjs');

const ACCOUNT = 'electron-account-renderer-state-v1';
const ATOMS = 'electron-persisted-atom-state';
const MAPPING = 'app-server-project-id-by-legacy-project-id-by-host';
const MIGRATION = 'app-server-projects-migration-by-host';
const clone = value => structuredClone(value);
const unique = values => [...new Set(values)];
const mapObject = value => value && typeof value === 'object' && !Array.isArray(value);
const pairs = value => Object.entries(mapObject(value) ? value : {});
const readJson = file => parseJson(fs.readFileSync(file));
const canonical = value => Array.isArray(value) ? value.map(canonical) : mapObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function planFingerprint(plan) {
  const { summary, statePath, fingerprint, ...payload } = plan;
  return digest(JSON.stringify(canonical(payload)));
}

function validate(state) {
  assert(mapObject(state) && mapObject(state[ACCOUNT]), 'Unsupported account-state format; no changes made.');
  const account = state[ACCOUNT];
  assert(account.owner === null || typeof account.owner === 'string', 'Unsupported account owner.');
  assert(mapObject(account.inactive), 'Unsupported inactive account format.');
  for (const [, scope] of pairs(account.inactive)) {
    assert(mapObject(scope) && mapObject(scope.globals) && mapObject(scope.atoms), 'Unsupported saved account format.');
  }
  assert(state[ATOMS] == null || mapObject(state[ATOMS]), 'Unsupported active UI state format.');
  for (const globals of [state, ...Object.values(account.inactive).map(scope => scope.globals)]) {
    for (const key of ['local-projects', 'thread-project-assignments']) {
      assert(globals[key] == null || mapObject(globals[key]), `Unsupported ${key} format.`);
    }
    for (const [, project] of pairs(globals['local-projects'])) assert(mapObject(project), 'Unsupported local project record.');
    for (const key of ['project-order', 'projectless-thread-ids', 'electron-saved-workspace-roots']) {
      assert(globals[key] == null || (Array.isArray(globals[key]) && globals[key].every(value => typeof value === 'string')), `Unsupported ${key} format.`);
    }
    for (const key of [MAPPING, MIGRATION, 'thread-project-membership-host-ids']) {
      assert(globals[key] == null || mapObject(globals[key]), `Unsupported ${key} format.`);
    }
  }
}

function getTarget(state, owner) {
  validate(state);
  if (state[ACCOUNT].owner === owner) {
    return { globals: state, atoms: state[ATOMS] || {}, active: true };
  }
  assert(state[ACCOUNT].owner === null, 'The signed-in account changed. Run the tool again.');
  const saved = state[ACCOUNT].inactive[owner];
  assert(saved, 'The destination account is no longer present.');
  return { ...saved, active: false };
}

function isPureLocal(id, project) {
  if (!mapObject(project) || project.id !== id || !Array.isArray(project.rootPaths) || !project.rootPaths.length) return false;
  if (id.startsWith('g-p-') || !project.rootPaths.every(root => typeof root === 'string' && path.isAbsolute(root))) return false;
  return !pairs(project).some(([key, value]) => value != null && /^(chatGpt|retiredChatGpt|remote|cloud)/i.test(key));
}

function buildPlan(state, options = {}) {
  validate(state);
  const owner = options.targetOwner || state[ACCOUNT].owner;
  assert(typeof owner === 'string' && owner.length, 'Open Codex and sign in to the destination account first.');
  const target = getTarget(state, owner);
  const scopes = [{ globals: state, atoms: state[ATOMS] || {} }, ...Object.values(state[ACCOUNT].inactive)];
  const providers = new Map();
  let excludedLinkedProjects = 0;
  for (const scope of scopes) {
    for (const [id, project] of pairs(scope.globals['local-projects'])) {
      if (!isPureLocal(id, project)) { excludedLinkedProjects++; continue; }
      const prior = providers.get(id);
      if (!prior || (project.updatedAt || 0) > (prior.project.updatedAt || 0)) providers.set(id, { project, scope });
    }
  }
  const projects = Object.fromEntries([...providers].filter(([id]) =>
    !Object.hasOwn(target.globals['local-projects'] || {}, id)).map(([id, value]) => [id, clone(value.project)]));
  const newIds = new Set(Object.keys(projects));
  const explicitProjectless = new Set(target.globals['projectless-thread-ids'] || []);
  const assignmentOptions = new Map();
  for (const scope of scopes) {
    for (const [threadId, assignment] of pairs(scope.globals['thread-project-assignments'])) {
      if (Object.hasOwn(target.globals['thread-project-assignments'] || {}, threadId) || explicitProjectless.has(threadId)) continue;
      if (assignment?.projectKind !== 'local' || assignment.projectOrigin === 'chatgpt' || !providers.has(assignment.projectId)) continue;
      const existingProject = target.globals['local-projects']?.[assignment.projectId];
      if (existingProject && !isPureLocal(assignment.projectId, existingProject)) continue;
      const host = scope.globals['thread-project-membership-host-ids']?.[threadId];
      if (host != null && host !== 'local') continue;
      const options = assignmentOptions.get(threadId) || new Map();
      options.set(assignment.projectId, { assignment, host });
      assignmentOptions.set(threadId, options);
    }
  }
  const assignments = {}, membershipHosts = {};
  let conflictingAssignments = 0;
  for (const [threadId, options] of assignmentOptions) {
    if (options.size !== 1) { conflictingAssignments++; continue; }
    const option = options.values().next().value;
    assignments[threadId] = clone(option.assignment);
    if (option.host) membershipHosts[threadId] = option.host;
  }
  const globals = {}, atoms = {}, mappings = {};
  for (const key of ['project-appearances', 'sidebar-project-thread-orders']) {
    globals[key] = Object.fromEntries([...newIds].flatMap(id => {
      const value = providers.get(id).scope.globals[key]?.[id];
      return value == null ? [] : [[id, clone(value)]];
    }));
  }
  globals['thread-project-membership-host-ids'] = membershipHosts;
  const roots = unique(Object.values(projects).flatMap(project => project.rootPaths));
  globals['electron-workspace-root-labels'] = {};
  const ordering = [];
  for (const scope of scopes) {
    for (const [root, label] of pairs(scope.globals['electron-workspace-root-labels'])) {
      if (roots.includes(root)) globals['electron-workspace-root-labels'][root] = label;
    }
    ordering.push(...(scope.globals['project-order'] || []).filter(id => newIds.has(id)));
    for (const [host, mapping] of pairs(scope.globals[MAPPING])) {
      if (!host.startsWith('local:')) continue;
      for (const [id, serverId] of pairs(mapping)) {
        if (newIds.has(id) && providers.get(id).scope === scope) { mappings[host] ||= {}; mappings[host][id] ||= serverId; }
      }
    }
  }
  for (const id of newIds) {
    const key = `sidebar-project-expanded-v1-codex:${id}`;
    const value = providers.get(id).scope.atoms[key];
    if (typeof value === 'boolean') atoms[key] = value;
  }
  const projectOrder = unique([...ordering, ...newIds]);
  const plan = { schemaVersion: 2, targetOwner: owner, projects, assignments, globals, atoms,
    roots, mappings, projectOrder, summary: {
      currentProjects: pairs(target.globals['local-projects']).length,
      addProjects: newIds.size, addAssignments: Object.keys(assignments).length,
      conflictingAssignments, excludedLinkedProjects,
      recoverableProjects: providers.size,
      outcome: providers.size === 0 ? 'no_local_source' : conflictingAssignments > 0 ? 'conflicts'
        : newIds.size > 0 || Object.keys(assignments).length > 0 ? 'ready' : 'already_complete',
      needsRestart: newIds.size > 0 || Object.keys(assignments).length > 0
    } };
  plan.fingerprint = planFingerprint(plan);
  return plan;
}

function applyPlan(input, plan, statePath) {
  assert.equal(plan.schemaVersion, 2, 'Unsupported plan format. Run the current tool again.');
  assert.equal(plan.fingerprint, planFingerprint(plan), 'The plan was modified. Run the tool again.');
  const state = clone(input), target = getTarget(state, plan.targetOwner);
  const freshPlan = buildPlan(input, { targetOwner: plan.targetOwner });
  if (verify(input, plan).recordsMatch) return state;
  assert.equal(freshPlan.fingerprint, plan.fingerprint, 'Local project metadata changed after planning. Nothing was written; run the tool again.');
  if (!plan.summary.needsRestart) return state;
  if (target.active && !state[ATOMS]) state[ATOMS] = target.atoms;
  const globals = target.globals, atoms = target.atoms;
  const allowedGlobals = new Set(), allowedAtoms = new Set();
  function put(key, value) { allowedGlobals.add(key); globals[key] = value; }
  function merge(key, value) {
    if (pairs(value).length) put(key, { ...clone(value), ...globals[key] });
  }
  merge('local-projects', plan.projects);
  const projectless = new Set(globals['projectless-thread-ids'] || []);
  const assignments = Object.fromEntries(pairs(plan.assignments).filter(([id]) => !projectless.has(id)));
  merge('thread-project-assignments', assignments);
  for (const [key, value] of pairs(plan.globals)) merge(key, value);
  if (plan.roots.length) put('electron-saved-workspace-roots', unique([...(globals['electron-saved-workspace-roots'] || []), ...plan.roots]));
  if (plan.projectOrder.length) {
    put('project-order', unique([...(globals['project-order'] || []), ...plan.projectOrder]));
    const key = 'unified-sidebar-project-order-v1';
    allowedAtoms.add(key);
    atoms[key] = unique([...(atoms[key] || []), ...plan.projectOrder.map(id => `codex:project:${id}`)]);
    allowedAtoms.add('sidebar-project-list-expanded-v1');
    atoms['sidebar-project-list-expanded-v1'] = true;
  }
  for (const [key, value] of pairs(plan.atoms)) {
    if (!Object.hasOwn(atoms, key)) { allowedAtoms.add(key); atoms[key] = value; }
  }
  const mappings = clone(globals[MAPPING] || {});
  for (const [host, mapping] of pairs(plan.mappings)) mappings[host] = { ...mapping, ...mappings[host] };
  if (pairs(plan.mappings).length) put(MAPPING, mappings);
  const migrations = clone(globals[MIGRATION] || {});
  const hosts = unique([...Object.keys(mappings), ...Object.keys(migrations)]).filter(host => host.startsWith('local:'));
  if (!hosts.length) hosts.push(`local:${path.dirname(statePath)}`);
  for (const host of hosts) {
    migrations[host] = { ...migrations[host], version: 1, projectsMigrated: false,
      threadAssignmentsMigrated: false, threadAssignmentsReadMigrated: false,
      pendingThreadAssignmentIds: unique([...(migrations[host]?.pendingThreadAssignmentIds || []), ...Object.keys(assignments)]) };
  }
  put(MIGRATION, migrations);
  const before = getTarget(input, plan.targetOwner);
  for (const [key, value] of pairs(before.globals)) {
    if (!allowedGlobals.has(key) && !(target.active && key === ATOMS)) assert.deepEqual(globals[key], value, `Unrelated global changed: ${key}`);
  }
  for (const [key, value] of pairs(before.atoms)) if (!allowedAtoms.has(key)) assert.deepEqual(atoms[key], value, `Unrelated UI state changed: ${key}`);
  for (const key of ['local-projects', 'thread-project-assignments']) {
    for (const [id, value] of pairs(before.globals[key])) assert.deepEqual(globals[key][id], value, 'An existing entry was overwritten.');
  }
  assert.equal(state[ACCOUNT].owner, input[ACCOUNT].owner);
  for (const [owner, value] of pairs(input[ACCOUNT].inactive)) {
    if (owner !== plan.targetOwner) assert.deepEqual(state[ACCOUNT].inactive[owner], value, 'Another account changed.');
  }
  return state;
}

function verify(state, plan) {
  const target = getTarget(state, plan.targetOwner);
  const normalizeRoot = root => process.platform === 'win32' ? path.normalize(root).toLowerCase() : path.normalize(root);
  const projects = pairs(plan.projects).filter(([id, expected]) => {
    const actual = target.globals['local-projects']?.[id];
    return !isPureLocal(id, actual) || actual.name !== expected.name ||
      !isDeepStrictEqual(actual.rootPaths.map(normalizeRoot), expected.rootPaths.map(normalizeRoot));
  });
  const assignments = pairs(plan.assignments).filter(([id, expected]) =>
    target.globals['thread-project-assignments']?.[id]?.projectId !== expected.projectId ||
    target.globals['thread-project-assignments']?.[id]?.projectKind !== 'local' ||
    target.globals['thread-project-assignments']?.[id]?.projectOrigin === 'chatgpt');
  return { activeAccount: target.active, missingProjects: projects.length, missingAssignments: assignments.length,
    recordsMatch: projects.length === 0 && assignments.length === 0,
    verificationScope: 'persisted_local_state',
    success: target.active && projects.length === 0 && assignments.length === 0 };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(args[i]?.startsWith('--') && args[i + 1], 'Invalid arguments.');
    options[args[i].slice(2)] = args[i + 1];
  }
  const statePath = path.resolve(options.state || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.codex-global-state.json'));
  const runDir = options['run-dir'] && path.resolve(options['run-dir']);
  assert(runDir, '--run-dir is required.');
  fs.mkdirSync(runDir, { recursive: true });
  if (command === 'plan') {
    const state = readJson(statePath), plan = buildPlan(state);
    plan.statePath = statePath;
    const trial = applyPlan(state, plan, statePath);
    assert(!buildPlan(trial).summary.needsRestart, 'The import is not idempotent.');
    writeAtomic(path.join(runDir, 'plan.json'), JSON.stringify(plan));
    console.log(JSON.stringify(plan.summary));
  } else {
    const plan = readJson(path.join(runDir, 'plan.json'));
    assert.equal(plan.statePath, statePath, 'State path differs from the prepared plan.');
    if (command === 'preflight') {
      const current = readJson(statePath), check = verify(current, plan);
      assert.equal(plan.fingerprint, planFingerprint(plan), 'The plan was modified. Run the tool again.');
      if (!check.recordsMatch) assert.equal(buildPlan(current, { targetOwner: plan.targetOwner }).fingerprint,
        plan.fingerprint, 'Local project metadata changed after planning. Nothing was written; run the tool again.');
      console.log(JSON.stringify({ ready: !check.recordsMatch, alreadyPresent: check.recordsMatch }));
    } else if (command === 'verify') {
      const result = verify(readJson(statePath), plan);
      console.log(JSON.stringify(result));
      process.exitCode = result.success ? 0 : 2;
    } else {
      assert.equal(command, 'apply');
      assert.equal(process.env.CODEX_LOCAL_SYNC_APP_CLOSED, '1', 'Use the shutdown-aware launcher.');
      const beforeBytes = fs.readFileSync(statePath), before = parseJson(beforeBytes);
      const state = applyPlan(before, plan, statePath);
      const changed = !isDeepStrictEqual(before, state);
      if (changed) {
        commitState({ statePath, beforeBytes, afterState: state, runDir });
      }
      const savedBackup = path.join(runDir, 'state.before.json');
      const result = { status: changed ? 'applied' : 'already_present', ...plan.summary,
        backup: fs.existsSync(savedBackup) ? savedBackup : null };
      writeAtomic(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
    }
  }
}

module.exports = { buildPlan, applyPlan, verify, isPureLocal, planFingerprint };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
