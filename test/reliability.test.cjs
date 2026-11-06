'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPlan, applyPlan, verify, planFingerprint } = require('../codex-local-projects.cjs');
const { commitState, writeAtomic, parseJson } = require('../state-store.cjs');
const A = 'electron-account-renderer-state-v1', T = 'electron-persisted-atom-state';

function fixture() {
  return { [A]: { owner: 'target', inactive: { source: { atoms: {}, globals: {
    'local-projects': { p: { id: 'p', name: 'Example', rootPaths: [path.resolve('fixture')], updatedAt: 1 } },
    'thread-project-assignments': { t: { projectKind: 'local', projectId: 'p' } }
  } } } }, [T]: {} };
}
function scratch(t) {
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'codex-reliability-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir), relative = path.relative(base, resolved);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert(path.basename(resolved).startsWith('codex-reliability-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}

test('empty history is distinguished from a successfully populated account', () => {
  const plan = buildPlan({ [A]: { owner: 'target', inactive: {} }, [T]: {} });
  assert.equal(plan.summary.outcome, 'no_local_source');
  assert.equal(plan.summary.recoverableProjects, 0);
});

test('verification rejects a wrong directory, name, project kind, or cloud origin', () => {
  const original = fixture(), plan = buildPlan(original), correct = applyPlan(original, plan, path.resolve('state.json'));
  for (const change of [
    state => { state['local-projects'].p.rootPaths = [path.resolve('wrong')]; },
    state => { state['local-projects'].p.name = 'Wrong'; },
    state => { state['thread-project-assignments'].t.projectKind = 'chatgpt'; },
    state => { state['thread-project-assignments'].t.projectOrigin = 'chatgpt'; }
  ]) {
    const altered = structuredClone(correct); change(altered);
    assert.equal(verify(altered, plan).success, false);
  }
});

test('stale and edited plans cannot overwrite newer account decisions', () => {
  const original = fixture(), plan = buildPlan(original);
  const newer = structuredClone(original);
  newer['local-projects'] = { p: { ...original[A].inactive.source.globals['local-projects'].p, name: 'New decision' } };
  assert.throws(() => applyPlan(newer, plan, path.resolve('state.json')), /metadata changed/);
  const edited = structuredClone(plan); edited.globals['unrelated-setting'] = { injected: true };
  assert.throws(() => applyPlan(original, edited, path.resolve('state.json')), /plan was modified/);
  edited.fingerprint = planFingerprint(edited);
  assert.throws(() => applyPlan(original, edited, path.resolve('state.json')), /metadata changed/);
});

test('malformed UI state and project records fail before any import', () => {
  const original = fixture(); original[T] = [];
  assert.throws(() => buildPlan(original), /UI state/);
  const nullProject = fixture(); nullProject['local-projects'] = { p: null };
  assert.throws(() => buildPlan(nullProject), /project record/);
  assert.deepEqual(parseJson(Buffer.from('\uFEFF{"value":1}')), { value: 1 });
});

for (const stage of ['fallback', 'primary', 'receipt']) {
  test(`transaction failure at ${stage} restores both original files`, t => {
    const dir = scratch(t), statePath = path.join(dir, 'state.json'), backupPath = `${statePath}.bak`;
    const before = Buffer.from('{"original":true}'), fallback = Buffer.from('{"previousBackup":true}');
    fs.writeFileSync(statePath, before); fs.writeFileSync(backupPath, fallback);
    const io = { ...fs, renameSync(source, target) {
      const contents = fs.readFileSync(source, 'utf8');
      const shouldFail = stage === 'fallback' && target === backupPath && contents.includes('after') ||
        stage === 'primary' && target === statePath && contents.includes('after') ||
        stage === 'receipt' && target.endsWith('transaction.json') && contents.includes('committed');
      if (shouldFail) throw Object.assign(new Error(`Injected ${stage} write failure`), { code: 'EIO' });
      return fs.renameSync(source, target);
    } };
    assert.throws(() => commitState({ statePath, beforeBytes: before, afterState: { after: true }, runDir: dir }, io), /original state and fallback were restored/);
    assert.deepEqual(fs.readFileSync(statePath), before);
    assert.deepEqual(fs.readFileSync(backupPath), fallback);
    assert.equal(parseJson(fs.readFileSync(path.join(dir, 'transaction.json'))).status, 'rolled_back');
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  });
}

test('rollback removes a newly created fallback when no fallback existed before', t => {
  const dir = scratch(t), statePath = path.join(dir, 'state.json'), before = Buffer.from('{"original":true}');
  fs.writeFileSync(statePath, before);
  const io = { ...fs, renameSync(source, target) {
    if (target === statePath) throw Object.assign(new Error('Injected primary failure'), { code: 'EIO' });
    return fs.renameSync(source, target);
  } };
  assert.throws(() => commitState({ statePath, beforeBytes: before, afterState: { after: true }, runDir: dir }, io), /restored/);
  assert.deepEqual(fs.readFileSync(statePath), before);
  assert.equal(fs.existsSync(`${statePath}.bak`), false);
});

test('an unexpected external write is preserved instead of being overwritten by rollback', t => {
  const dir = scratch(t), statePath = path.join(dir, 'state.json'), before = Buffer.from('{"original":true}');
  const external = Buffer.from('{"newerExternalDecision":true}');
  fs.writeFileSync(statePath, before);
  const io = { ...fs, renameSync(source, target) {
    fs.renameSync(source, target);
    if (target === `${statePath}.bak`) fs.writeFileSync(statePath, external);
  } };
  assert.throws(() => commitState({ statePath, beforeBytes: before, afterState: { after: true }, runDir: dir }, io), /recovery needs review/);
  assert.deepEqual(fs.readFileSync(statePath), external);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.before.json')), before);
});

test('a transient Windows file lock is retried before abandoning an atomic write', t => {
  const dir = scratch(t), file = path.join(dir, 'state.json'); let attempts = 0;
  const io = { ...fs, renameSync(source, target) {
    if (attempts++ < 2) throw Object.assign(new Error('Transient file lock'), { code: 'EPERM' });
    return fs.renameSync(source, target);
  } };
  writeAtomic(file, 'verified', io);
  assert.equal(fs.readFileSync(file, 'utf8'), 'verified');
  assert.equal(attempts, 3);
});

test('a change before commit is reported as aborted and does not touch either state file', t => {
  const dir = scratch(t), statePath = path.join(dir, 'state.json');
  const original = Buffer.from('{"original":true}'), external = Buffer.from('{"newer":true}');
  fs.writeFileSync(statePath, external);
  fs.writeFileSync(`${statePath}.bak`, original);
  assert.throws(() => commitState({ statePath, beforeBytes: original, afterState: { after: true }, runDir: dir }), /changed concurrently/);
  assert.deepEqual(fs.readFileSync(statePath), external);
  assert.deepEqual(fs.readFileSync(`${statePath}.bak`), original);
  assert.equal(parseJson(fs.readFileSync(path.join(dir, 'transaction.json'))).status, 'aborted_before_write');
});
