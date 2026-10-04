'use strict';
// Creates test rooms on the explicitly supplied deployment. The private state
// file contains seat credentials; keep it outside the repository and delete it
// after the recovery drill. This is not part of the application image.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const [phase, base, file] = process.argv.slice(2);

async function main() {
  if (!['seed', 'verify', 'finish'].includes(phase) || !base || !file || process.argv.length !== 5) throw Error('Usage: node scripts/smoke-deployment.cjs <seed|verify|finish> <base-url> <private-state-file>');
  const origin = new URL(base);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== base) throw Error('Use an exact HTTP(S) origin.');
  async function request(route, token, body) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.ok, true, `${route.split('?')[0]} returned ${response.status}`);
    return response;
  }
  async function action(state, guest, type, payload = {}) {
    const current = await (await request(`/api/rooms/${state.code}`, guest.token)).json();
    return (await request(`/api/rooms/${state.code}/actions`, guest.token, { id: randomUUID(), version: current.room.version, type, payload })).json();
  }
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { ready = (await fetch(base + '/readyz', { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Replacement pods may still be starting. */ }
    if (ready) break;
    await wait(200);
  }
  assert.ok(ready, 'Deployment did not become ready');
  for (const route of ['/healthz', '/readyz', '/', '/online.html']) await request(route);
  if (phase === 'seed') {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      const host = await (await request('/api/rooms', null, { name: 'Recovery host', mode: 'draft', config: { order: 'manual', format: 'spec', pickTimer: 0 } })).json();
      const code = host.room.code;
      const guest = await (await request(`/api/rooms/${code}/join`, null, { name: 'Recovery guest' })).json();
      const state = { code, host: { token: host.token }, guest: { token: guest.token } };
      await action(state, state.host, 'ready', { ready: true });
      await action(state, state.guest, 'ready', { ready: true });
      await action(state, state.host, 'start');
      await action(state, state.host, 'pick', { index: 0, name: 'Saved hero' });
      const paused = await action(state, state.host, 'pause');
      state.room = paused.room;
      fs.writeFileSync(fd, JSON.stringify(state));
      console.log('PASS: seeded a paused two-player game after an authoritative selection.');
    } finally { fs.closeSync(fd); }
    return;
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const current = await (await request(`/api/rooms/${state.code}`, state.host.token)).json();
  assert.deepEqual(current.room.game, state.room.game, 'Committed game changed across restart/restore');
  assert.equal(current.room.status, 'paused');
  assert.equal(current.room.version, state.room.version);
  await request(`/api/rooms/${state.code}`, state.guest.token);
  const progress = await (await request(`/api/rooms/${state.code}/export?format=json`, state.guest.token)).json();
  assert.equal(progress.status, 'paused');
  assert.equal(progress.roster.filter(p => p.complete).length, 1);
  if (phase === 'verify') {
    console.log('PASS: saved state, both guest credentials, and progress export survived restart/restore.'); return;
  }
  await action(state, state.host, 'resume');
  await action(state, state.guest, 'pick', { index: 0 });
  const result = await (await request(`/api/rooms/${state.code}/export?format=json`, state.host.token)).json();
  assert.equal(result.status, 'done');
  assert.equal(result.roster.length, 2);
  assert.ok(result.roster.every(p => p.complete));
  const csv = await (await request(`/api/rooms/${state.code}/export?format=csv`, state.guest.token)).text();
  assert.ok(csv.includes('Saved hero'));
  assert.equal(csv.trim().split('\r\n').length, 3);
  assert.ok(!JSON.stringify(result).includes(state.host.token));
  console.log('PASS: recovered participants completed the game and exported matching JSON/CSV results.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
