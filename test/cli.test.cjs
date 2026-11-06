'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildPlan, applyPlan, verify } = require('../codex-local-projects.cjs');
const ACCOUNT = 'electron-account-renderer-state-v1';
const ATOMS = 'electron-persisted-atom-state';
const core = path.resolve(__dirname, '../codex-local-projects.cjs');

function fixture(root, projectCount = 1, threadCount = 1) {
  const projects = Object.fromEntries(Array.from({ length: projectCount }, (_, i) => [
    `project-${i}`, { id: `project-${i}`, name: `Example ${i}`, rootPaths: [root], createdAt: 1, updatedAt: 1 }
  ]));
  const assignments = Object.fromEntries(Array.from({ length: threadCount }, (_, i) => [
    `thread-${i}`, { projectKind: 'local', projectId: `project-${i % projectCount}` }
  ]));
  return {
    [ACCOUNT]: { owner: 'destination-example', inactive: {
      'source-example': { atoms: {}, globals: {
        'local-projects': projects, 'thread-project-assignments': assignments
      } }
    } },
    [ATOMS]: { cloudSentinel: { projectId: 'g-p-example' }, preferences: { theme: 'light' } }
  };
}

test('many projects and assignments import without relying on machine or account details', () => {
  const root = path.resolve(__dirname, 'fixture'), input = fixture(root, 29, 381);
  const plan = buildPlan(input);
  assert.equal(plan.summary.addProjects, 29);
  assert.equal(plan.summary.addAssignments, 381);
  const output = applyPlan(input, plan, path.join(root, 'state.json'));
  assert(verify(output, plan).success);
  assert.equal(buildPlan(output).summary.needsRestart, false);
  assert.deepEqual(output[ACCOUNT], input[ACCOUNT]);
  assert.deepEqual(output[ATOMS].cloudSentinel, input[ATOMS].cloudSentinel);
});

test('CLI creates a pre-change backup, writes verified state, and refuses an unguarded apply', t => {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'codex-local-projects-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory), relative = path.relative(fs.realpathSync(tempRoot), resolved);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert(path.basename(resolved).startsWith('codex-local-projects-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const statePath = path.join(directory, 'state.json'), runDir = path.join(directory, 'run');
  const original = fixture(directory);
  const originalText = JSON.stringify(original);
  fs.writeFileSync(statePath, originalText);
  function run(command, closed = false) {
    const env = { ...process.env };
    delete env.CODEX_LOCAL_SYNC_APP_CLOSED;
    if (closed) env.CODEX_LOCAL_SYNC_APP_CLOSED = '1';
    return spawnSync(process.execPath, [core, command, '--state', statePath, '--run-dir', runDir], {
      env, encoding: 'utf8'
    });
  }
  const planned = run('plan');
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).addProjects, 1);
  assert.equal(fs.readFileSync(statePath, 'utf8'), originalText);
  const rejected = run('apply');
  assert.notEqual(rejected.status, 0);
  assert.equal(fs.readFileSync(statePath, 'utf8'), originalText);
  const applied = run('apply', true);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(path.join(runDir, 'state.before.json'), 'utf8'), originalText);
  const actual = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(actual[ACCOUNT], original[ACCOUNT]);
  assert.deepEqual(actual[ATOMS].cloudSentinel, original[ATOMS].cloudSentinel);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${statePath}.bak`, 'utf8')), actual);
  const verified = run('verify');
  assert.equal(verified.status, 0, verified.stderr);
  assert(JSON.parse(verified.stdout).success);
  assert.equal(run('apply', true).status, 0, 'Repeated apply must be harmless.');
});
