'use strict';
// Isolated evidence only: no URL or database input is accepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createApp } = require('../server/server.cjs');
const { backupDatabase } = require('./backup.cjs');
const execute = promisify(execFile);

function configuration(args) {
  const config = { rooms: 4, rounds: 10 };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!['--rooms', '--rounds'].includes(args[i]) || !/^\d+$/.test(args[i + 1] || '')) throw Error('invalid_configuration');
    config[key] = Number(args[i + 1]);
  }
  if (config.rooms < 1 || config.rooms > 16 || config.rounds < 1 || config.rounds > 25) throw Error('invalid_configuration');
  return config;
}

function measurement() {
  const samples = [];
  const statuses = {};
  let errors = 0;
  return {
    async request(base, route, token, body, expected = 200, transport = fetch) {
      const start = performance.now();
      try {
        const response = await transport(base + route, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
        });
        statuses[response.status] = (statuses[response.status] || 0) + 1;
        if (response.status !== expected) throw Error('unexpected_status');
        return await response.json();
      } catch { errors++; throw Error('request_failed'); }
      finally { samples.push(performance.now() - start); }
    },
    summary() {
      const ordered = [...samples].sort((a, b) => a - b);
      const percentile = fraction => Number((ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] || 0).toFixed(3));
      return { requests: samples.length, errors, statuses, latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: percentile(1) } };
    },
  };
}

async function loadRooms(base, config, meter) {
  const request = (...args) => meter.request(base, ...args);
  const results = await Promise.allSettled(Array.from({ length: config.rooms }, async () => {
    const host = await request('/api/rooms', null, { name: 'Qualification host', mode: 'draft', config: { order: 'manual', format: 'spec', pickTimer: 0 } }, 201);
    const route = `/api/rooms/${host.room.code}`;
    const guest = await request(`${route}/join`, null, { name: 'Qualification guest' }, 201);
    let room = guest.room;
    async function action(seat, type, payload = {}) {
      const version = room.version;
      room = (await request(`${route}/actions`, seat.token, { id: randomUUID(), version, type, payload })).room;
      assert.equal(room.version, version + 1);
    }
    for (let round = 0; round < config.rounds; round++) {
      const ready = round % 2 === 0;
      await action(host, 'ready', { ready });
      await action(guest, 'ready', { ready });
      const views = await Promise.all([host, guest].map(seat => request(route, seat.token)));
      for (const view of views) {
        assert.deepEqual(view.room, room);
        assert.equal(view.room.participants.length, 2);
        assert.ok(view.room.participants.every(seat => seat.ready === ready));
      }
    }
    await action(host, 'ready', { ready: true });
    await action(guest, 'ready', { ready: true });
    await action(host, 'start');
    await action(host, 'pick', { index: 0, name: 'Qualification hero' });
    await action(guest, 'pick', { index: 0 });
    const result = await request(`${route}/export?format=json`, guest.token);
    assert.equal(result.status, 'done');
    assert.equal(result.roster.length, 2);
    assert.ok(result.roster.every(seat => seat.complete));
  }));
  // Wait for all workers before closing the application on failure.
  if (results.some(result => result.status === 'rejected')) throw Error('load_correctness_failed');
}

async function qualify(config) {
  // Validate programmatic callers with the same bounds as the CLI.
  config = configuration(['--rooms', String(config.rooms), '--rounds', String(config.rounds)]);
  const meter = measurement();
  const report = { schemaVersion: 1, scope: 'isolated-local-application', node: process.version, config,
    passed: false, load: null, recovery: { passed: false }, failure: null };
  let directory, app, stage = 'setup';
  const started = performance.now();
  async function boot(dataDir) {
    // Pin fixture settings so inherited deployment variables cannot select data,
    // proxy trust, quotas, or expiry. Keep normal rate and creation limits.
    app = createApp({ dataDir, publicOrigin: 'https://qualification.invalid', trustProxy: '',
      roomTtlDays: 30, lobbyTtlDays: 7, maxRooms: 1000, maxCommands: 20000,
      bodyLimit: 16384, rateLimit: 3600, createLimit: 20, maxDbBytes: 2147483648, commandHistory: 16 });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  async function smoke(phase, base, state) {
    // Child output/assertions can contain private state; never relay them.
    await execute(process.execPath, [path.join(__dirname, 'smoke-deployment.cjs'), phase, base, state], { timeout: 45000, maxBuffer: 1024 * 1024 });
  }
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'war-table-qualification-'));
    const source = path.join(directory, 'source');
    const base = await boot(source);
    stage = 'load';
    await loadRooms(base, config, meter);
    stage = 'recovery_seed';
    const state = path.join(directory, 'private-seats.json');
    await smoke('seed', base, state);
    stage = 'backup';
    const recoveryStarted = performance.now();
    const snapshot = path.join(directory, 'snapshot.sqlite');
    await backupDatabase(path.join(source, 'rooms.sqlite'), snapshot);
    await app.close(); app = null;
    stage = 'restore';
    const restored = path.join(directory, 'restored');
    fs.mkdirSync(restored, { mode: 0o700 });
    fs.copyFileSync(snapshot, path.join(restored, 'rooms.sqlite'), fs.constants.COPYFILE_EXCL);
    const restoredBase = await boot(restored);
    stage = 'recovery_verify';
    await smoke('verify', restoredBase, state);
    stage = 'recovery_finish';
    await smoke('finish', restoredBase, state);
    report.recovery = { passed: true, method: 'sqlite-online-backup-to-fresh-directory', elapsedMs: Math.round(performance.now() - recoveryStarted) };
    report.passed = true;
  } catch { report.failure = stage; }
  finally {
    try { if (app) await app.close(); } catch { report.passed = false; report.failure = 'cleanup'; }
    try { if (directory) fs.rmSync(directory, { recursive: true, force: true }); } catch { report.passed = false; report.failure = 'cleanup'; }
  }
  report.load = meter.summary();
  report.elapsedMs = Math.round(performance.now() - started);
  return report;
}

if (require.main === module) {
  (async () => {
    let report;
    try { report = await qualify(configuration(process.argv.slice(2))); }
    catch { report = { schemaVersion: 1, passed: false, failure: 'invalid_configuration' }; }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  })();
}
module.exports = { configuration, measurement, loadRooms, qualify };
