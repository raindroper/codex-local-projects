'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('the exact distribution file set runs independently of the source checkout', t => {
  const repo = path.resolve(__dirname, '..'), base = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'codex-distribution-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir), relative = path.relative(base, resolved);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert(path.basename(resolved).startsWith('codex-distribution-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const files = JSON.parse(fs.readFileSync(path.join(repo, 'runtime-files.json'), 'utf8'));
  assert.equal(new Set(files).size, files.length);
  for (const file of files) {
    assert.equal(path.basename(file), file);
    fs.copyFileSync(path.join(repo, file), path.join(dir, file));
  }
  const source = { 'electron-account-renderer-state-v1': { owner: 'target', inactive: {
    old: { atoms: {}, globals: { 'local-projects': { p: { id: 'p', name: 'Example', rootPaths: [dir] } } } }
  } }, 'electron-persisted-atom-state': {} };
  const statePath = path.join(dir, 'fixture.json'); fs.writeFileSync(statePath, JSON.stringify(source));
  const result = spawnSync(process.execPath, [path.join(dir, 'codex-local-projects.cjs'), 'plan',
    '--state', statePath, '--run-dir', path.join(dir, 'run')], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).addProjects, 1);
  assert(files.includes('launcher-functions.ps1'));
  assert(files.includes('state-store.cjs'));
});
