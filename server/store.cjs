'use strict';
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync, chmodSync } = require('node:fs');
const { join } = require('node:path');

function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'rooms.sqlite'));
  chmodSync(join(dataDir, 'rooms.sqlite'), 0o600);
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') { db.close(); throw new Error('SQLite integrity check failed'); }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS seats (room TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE, hash TEXT NOT NULL, participant TEXT NOT NULL, PRIMARY KEY(room, hash));
    CREATE TABLE IF NOT EXISTS commands (room TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE, participant TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(room, participant, id));`);
  const q = (sql) => db.prepare(sql);
  return {
    transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    get(code) { const row = q('SELECT value FROM rooms WHERE code=?').get(code); return row ? JSON.parse(row.value) : null; },
    put(room) { q('INSERT INTO rooms(code,value,expires) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET value=excluded.value,expires=excluded.expires').run(room.code, JSON.stringify(room), room.expiresAt); },
    seat(code, hash, participant) { q('INSERT INTO seats(room,hash,participant) VALUES(?,?,?)').run(code, hash, participant); },
    removeParticipant(code, participant) { q('DELETE FROM seats WHERE room=? AND participant=?').run(code, participant); q('DELETE FROM commands WHERE room=? AND participant=?').run(code, participant); },
    authenticate(code, hash) { return q('SELECT participant FROM seats WHERE room=? AND hash=?').get(code, hash)?.participant; },
    command(code, participant, id) { return q('SELECT body,response FROM commands WHERE room=? AND participant=? AND id=?').get(code, participant, id); },
    record(code, participant, id, body, response) { q('INSERT INTO commands(room,participant,id,body,response) VALUES(?,?,?,?,?)').run(code, participant, id, body, JSON.stringify(response)); },
    commandCount(code) { return q('SELECT count(*) AS n FROM commands WHERE room=?').get(code).n; },
    count() { return q('SELECT count(*) AS n FROM rooms').get().n; },
    prune(now) { q('DELETE FROM rooms WHERE expires<=?').run(now); },
    active() { return q('SELECT value FROM rooms WHERE json_extract(value,\'$.status\')=\'playing\'').all().map(row => JSON.parse(row.value)); },
    healthy() { return q('SELECT 1 AS ok').get().ok === 1; },
    close() { db.close(); },
  };
}
module.exports = { createStore };
