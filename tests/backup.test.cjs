'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { backupDatabase } = require('../scripts/backup.cjs');

test('online backup captures committed WAL data and preserves earlier backups', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-table-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'rooms.sqlite');
  const destination = path.join(dir, 'snapshot.sqlite');
  const db = new DatabaseSync(source);
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE rooms(id TEXT); INSERT INTO rooms VALUES (\'saved-game\')');
  assert.ok(fs.statSync(`${source}-wal`).size > 0);
  await backupDatabase(source, destination);
  const copy = new DatabaseSync(destination, { readOnly: true });
  assert.equal(copy.prepare('SELECT id FROM rooms').get().id, 'saved-game');
  copy.close();
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  await assert.rejects(backupDatabase(source, destination), { code: 'EEXIST' });
  await assert.rejects(backupDatabase(source, source), /must differ/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rooms').get().n, 1);
});

test('backup rejects missing and corrupt sources without leaving a false backup', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-table-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const destination = path.join(dir, 'snapshot.sqlite');
  await assert.rejects(backupDatabase(path.join(dir, 'missing.sqlite'), destination));
  assert.equal(fs.existsSync(destination), false);
  const corrupt = path.join(dir, 'bad.sqlite');
  fs.writeFileSync(corrupt, 'not a SQLite database');
  await assert.rejects(backupDatabase(corrupt, destination));
  assert.equal(fs.existsSync(destination), false);
});
