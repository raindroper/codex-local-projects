'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildPlan, applyPlan, verify } = require('../codex-local-projects.cjs');
const ACCOUNT = 'electron-account-renderer-state-v1';
const ATOMS = 'electron-persisted-atom-state';
const statePath = path.resolve('work/fixture/.codex-global-state.json');
const project = (id, name = id) => ({ id, name, rootPaths: [path.resolve(`work/fixture/${id}`)], createdAt: 1, updatedAt: 1 });
function base() {
  return { [ACCOUNT]: { owner: 'new-account', inactive: { old: { atoms: {}, globals: {
    'local-projects': { p: project('p') },
    'thread-project-assignments': { t: { projectKind: 'local', projectId: 'p' } },
    'thread-project-membership-host-ids': { t: 'local' },
    'project-order': ['p'],
    'app-server-project-id-by-legacy-project-id-by-host': { 'local:fixture': { p: 'server-p' } }
  } } } }, [ATOMS]: { cloudState: { project: 'g-p-existing' }, preferences: { theme: 'light' } },
    'thread-writable-roots': { current: ['unchanged'] }, otherConfiguration: 42 };
}

test('empty new account imports local records, preserves cloud/settings/source, and becomes a no-op', () => {
  const input = base(), original = structuredClone(input), plan = buildPlan(input);
  assert.equal(plan.summary.addProjects, 1); assert.equal(plan.summary.addAssignments, 1);
  const output = applyPlan(input, plan, statePath);
  assert.deepEqual(input, original);
  assert.deepEqual(output[ACCOUNT], input[ACCOUNT]);
  assert.deepEqual(output[ATOMS].cloudState, input[ATOMS].cloudState);
  assert.deepEqual(output['thread-writable-roots'], input['thread-writable-roots']);
  assert(verify(output, plan).success);
  assert.equal(buildPlan(output).summary.needsRestart, false);
});

test('current names, assignments and explicit projectless choices take priority', () => {
  const input = base();
  input['local-projects'] = { p: project('p', 'My name'), q: project('q') };
  input['thread-project-assignments'] = { t: { projectKind: 'local', projectId: 'q' } };
  input[ACCOUNT].inactive.old.globals['thread-project-assignments'].unassigned = { projectKind: 'local', projectId: 'p' };
  input['projectless-thread-ids'] = ['unassigned'];
  const plan = buildPlan(input);
  assert.equal(plan.summary.needsRestart, false);
  assert.deepEqual(applyPlan(input, plan, statePath), input);
});

test('ambiguous old assignments are skipped without losing project entries', () => {
  const input = base();
  input[ACCOUNT].inactive.second = { atoms: {}, globals: {
    'local-projects': { q: project('q') }, 'thread-project-assignments': { t: { projectKind: 'local', projectId: 'q' } }
  } };
  const plan = buildPlan(input);
  assert.equal(plan.summary.addProjects, 2); assert.equal(plan.summary.addAssignments, 0);
  assert.equal(plan.summary.conflictingAssignments, 1);
});

test('cloud linked projects and remote-host assignments are excluded', () => {
  const input = base(), old = input[ACCOUNT].inactive.old.globals;
  old['local-projects'].linked = { ...project('linked'), chatGptBacking: { projectId: 'g-p-private' } };
  old['thread-project-assignments'].cloud = { projectKind: 'local', projectId: 'linked' };
  old['thread-project-membership-host-ids'].t = 'ssh-host';
  const plan = buildPlan(input);
  assert.equal(plan.summary.addProjects, 1); assert.equal(plan.summary.addAssignments, 0);
  assert(!Object.hasOwn(plan.projects, 'linked'));
});

test('existing cloud-linked destination cannot receive old local assignments', () => {
  const input = base();
  input['local-projects'] = { p: { ...project('p'), chatGptBacking: { projectId: 'g-p-current' } } };
  assert.equal(buildPlan(input).summary.needsRestart, false);
});

test('account switch races fail; a signed-out saved destination is supported offline', () => {
  const input = base(), plan = buildPlan(input);
  const switched = structuredClone(input); switched[ACCOUNT].owner = 'third-account';
  assert.throws(() => applyPlan(switched, plan, statePath), /account changed/);
  const closed = structuredClone(input);
  closed[ACCOUNT].inactive['new-account'] = { atoms: closed[ATOMS], globals: {} };
  closed[ACCOUNT].owner = null;
  const result = applyPlan(closed, plan, statePath);
  assert(result[ACCOUNT].inactive['new-account'].globals['local-projects'].p);
  assert.equal(verify(result, plan).activeAccount, false);
  assert.equal(verify(result, plan).success, false);
});

test('future incompatible formats fail closed', () => {
  assert.throws(() => buildPlan({}), /Unsupported/);
  const input = base(); input['local-projects'] = [];
  assert.throws(() => buildPlan(input), /Unsupported/);
});
