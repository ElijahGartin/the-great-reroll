'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

async function backupDatabase(source, destination) {
  if (path.resolve(source) === path.resolve(destination)) throw new Error('Source and destination must differ.');
  if (!fs.statSync(source).isFile()) throw new Error('Source must be an existing database file.');
  // Exclusive creation prevents accidental replacement of an earlier backup.
  const fd = fs.openSync(destination, 'wx', 0o600);
  fs.closeSync(fd);
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
    await backup(db, destination);
    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      const checks = copy.prepare('PRAGMA integrity_check').all();
      if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
    } finally { copy.close(); }
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally { if (db) db.close(); }
  return destination;
}

if (require.main === module) {
  const [destination, source = path.join(process.env.DATA_DIR || '/data', 'rooms.sqlite')] = process.argv.slice(2);
  if (!destination || process.argv.length > 4) {
    console.error('Usage: node scripts/backup.cjs <new-backup.sqlite> [source.sqlite]');
    process.exitCode = 1;
  } else {
    backupDatabase(source, destination).then(() => console.log(`Verified backup: ${destination}`), (error) => {
      console.error(`Backup failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
module.exports = { backupDatabase };
