'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const parseJson = text => JSON.parse(text.toString('utf8').replace(/^\uFEFF/, ''));
const retryCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);

function writeAtomic(file, contents, io = fs) {
  const temporary = `${file}.local-project-sync-${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = io.openSync(temporary, 'wx');
    io.writeFileSync(fd, contents);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    for (let attempt = 0; ; attempt++) {
      try { io.renameSync(temporary, file); break; }
      catch (error) {
        if (!retryCodes.has(error.code) || attempt >= 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (2 ** attempt));
      }
    }
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    if (io.existsSync(temporary)) io.unlinkSync(temporary);
  }
}

function durableBackup(file, contents, io) {
  if (io.existsSync(file)) {
    assert.equal(digest(io.readFileSync(file)), digest(contents), 'This run directory already contains a different backup.');
    return;
  }
  const fd = io.openSync(file, 'wx');
  try { io.writeFileSync(fd, contents); io.fsyncSync(fd); }
  finally { io.closeSync(fd); }
}

function commitState({ statePath, beforeBytes, afterState, runDir }, io = fs) {
  const backupPath = `${statePath}.bak`;
  for (const file of [statePath, backupPath]) {
    if (io.existsSync(file)) assert(io.lstatSync(file).isFile() && !io.lstatSync(file).isSymbolicLink(), 'State files must be regular files.');
  }
  const previousBackup = io.existsSync(backupPath) ? io.readFileSync(backupPath) : null;
  const afterBytes = Buffer.from(JSON.stringify(afterState), 'utf8');
  const beforeHash = digest(beforeBytes), afterHash = digest(afterBytes);
  const stateBackup = path.join(runDir, 'state.before.json');
  durableBackup(stateBackup, beforeBytes, io);
  if (previousBackup !== null) durableBackup(path.join(runDir, 'state.bak.before.json'), previousBackup, io);
  const receiptPath = path.join(runDir, 'transaction.json');
  const receipt = { status: 'prepared', beforeHash, afterHash, previousBackupExisted: previousBackup !== null,
    stateBackup, at: new Date().toISOString() };
  writeAtomic(receiptPath, JSON.stringify(receipt, null, 2), io);
  if (digest(io.readFileSync(statePath)) !== beforeHash) {
    receipt.status = 'aborted_before_write';
    receipt.error = 'State changed concurrently; no import was performed.';
    writeAtomic(receiptPath, JSON.stringify(receipt, null, 2), io);
    throw new Error(receipt.error);
  }
  try {
    // Replace the fallback first. The main file is the final commit point.
    writeAtomic(backupPath, afterBytes, io);
    assert.equal(digest(io.readFileSync(statePath)), beforeHash, 'State changed concurrently before commit.');
    writeAtomic(statePath, afterBytes, io);
    assert.equal(digest(io.readFileSync(statePath)), afterHash, 'Primary state verification failed.');
    assert.equal(digest(io.readFileSync(backupPath)), afterHash, 'Fallback state verification failed.');
    receipt.status = 'committed';
    writeAtomic(receiptPath, JSON.stringify(receipt, null, 2), io);
    return receipt;
  } catch (error) {
    const rollbackErrors = [];
    function restore(file, original) {
      try {
        const current = io.existsSync(file) ? io.readFileSync(file) : null;
        if (current !== null && original !== null && digest(current) === digest(original)) return;
        if (current === null && original === null) return;
        assert(current !== null && digest(current) === afterHash, 'An external writer changed this file; preserved its newer contents.');
        if (original === null) io.unlinkSync(file);
        else writeAtomic(file, original, io);
        assert.equal(io.existsSync(file) ? digest(io.readFileSync(file)) : null, original === null ? null : digest(original));
      } catch (rollbackError) { rollbackErrors.push(`${path.basename(file)}: ${rollbackError.message}`); }
    }
    restore(statePath, beforeBytes);
    restore(backupPath, previousBackup);
    receipt.status = rollbackErrors.length ? 'recovery_required' : 'rolled_back';
    receipt.error = error.message;
    receipt.rollbackErrors = rollbackErrors;
    try { writeAtomic(receiptPath, JSON.stringify(receipt, null, 2), io); } catch { /* Original backups remain durable. */ }
    const result = new Error(rollbackErrors.length
      ? `Import failed; recovery needs review. Original backup: ${stateBackup}. ${error.message}`
      : `Import failed; original state and fallback were restored. ${error.message}`);
    result.code = receipt.status;
    throw result;
  }
}

module.exports = { digest, parseJson, writeAtomic, commitState };
