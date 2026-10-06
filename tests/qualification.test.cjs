'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { configuration, measurement, loadRooms, qualify } = require('../scripts/qualify-production.cjs');

test('qualification accepts bounded local load and rejects external targets and excessive work', () => {
  assert.deepEqual(configuration([]), { rooms: 4, rounds: 10 });
  assert.deepEqual(configuration(['--rooms', '16', '--rounds', '25']), { rooms: 16, rounds: 25 });
  for (const args of [['--url', 'https://example.com'], ['--rooms', '0'], ['--rooms', '17'], ['--rounds', '26'], ['--rounds', '1.5'], ['--rooms']]) {
    assert.throws(() => configuration(args), /invalid_configuration/);
  }
});

test('unexpected statuses and transport failures fail closed without leaking credentials or bodies', async () => {
  const meter = measurement();
  const secret = 'private-recovery-credential';
  await assert.rejects(meter.request('http://unused.invalid', '/private-room', secret, undefined, 200,
    async () => new Response(JSON.stringify({ secret }), { status: 429 })), /^Error: request_failed$/);
  await assert.rejects(meter.request('http://unused.invalid', '/private-room', secret, undefined, 200,
    async () => { throw Error(secret); }), /^Error: request_failed$/);
  const summary = meter.summary();
  assert.equal(summary.errors, 2);
  assert.equal(summary.requests, 2);
  assert.deepEqual(summary.statuses, { 429: 1 });
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(JSON.stringify(summary).includes('private-room'), false);
});

test('successful HTTP responses with lost action versions fail correctness checks', async () => {
  const fake = { async request() { return { token: 'never-report-this', room: { code: 'PRIVATE', version: 1 } }; } };
  await assert.rejects(loadRooms('http://unused.invalid', { rooms: 2, rounds: 1 }, fake), /^Error: load_correctness_failed$/);
});

test('CLI emits redacted machine-readable failure with nonzero exit', () => {
  try {
    execFileSync(process.execPath, ['scripts/qualify-production.cjs', '--url', 'https://private.example/secret'], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('CLI must fail');
  } catch (error) {
    assert.equal(error.status, 1);
    assert.deepEqual(JSON.parse(error.stdout), { schemaVersion: 1, passed: false, failure: 'invalid_configuration' });
    assert.equal(error.stderr, '');
  }
});

test('isolated actual application supports concurrent polling/actions and fresh database recovery', async () => {
  const report = await qualify({ rooms: 4, rounds: 10 });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.failure, null);
  assert.equal(report.load.requests, 192);
  assert.equal(report.load.errors, 0);
  assert.deepEqual(report.load.statuses, { 200: 184, 201: 8 });
  assert.ok(report.load.latencyMs.max >= report.load.latencyMs.p95);
  assert.equal(report.recovery.passed, true);
  assert.equal(report.scope, 'isolated-local-application');
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'scope', 'node', 'config', 'passed', 'load', 'recovery', 'failure', 'elapsedMs']);
  assert.ok(!/token|Authorization|PRIVATE|Qualification hero|127\.0\.0\.1|sqlite-wal/.test(JSON.stringify(report)));
});
