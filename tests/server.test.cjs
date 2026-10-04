'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server.cjs');
const game = {
  normalizeConfig(mode, config) { if (!['draft', 'deal'].includes(mode) || !config || typeof config !== 'object' || Array.isArray(config)) throw Object.assign(new Error('Invalid configuration'), { statusCode: 400 }); return config; },
  start(room, now) { room.status = 'playing'; room.game = { count: 0, deadline: now + 60000 }; },
  act(room, actor, type) { if (type !== 'increment') throw Object.assign(new Error('Invalid action'), { statusCode: 400 }); room.game.count += 1; },
  tick() { return false; },
  roster(room) { return room.participants.map(p => ({ name: p.name, count: room.game?.count || 0 })); },
};
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reroll-server-'));
  let app = createApp({ dataDir: dir, game, rateLimit: 10000, ...options });
  async function listen() { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); }
  await listen();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    dir,
    get store() { return app.store; },
    async restart() { await app.close(); app = createApp({ dataDir: dir, game, rateLimit: 10000, ...options }); await listen(); },
    async request(route, { method = 'GET', token, body, headers = {}, raw } = {}) {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, headers: response.headers };
    },
  };
}
async function create(f, name = 'Host', mode = 'draft') { const r = await f.request('/api/rooms', { method: 'POST', body: { name, mode, config: {} } }); assert.equal(r.status, 201); return r.data; }
async function action(f, seat, type, payload, version, id = require('node:crypto').randomUUID()) { return f.request(`/api/rooms/${seat.room.code}/actions`, { method: 'POST', token: seat.token, body: { id, version, type, payload } }); }

test('rooms require isolated seat credentials; names cannot reclaim identities; host permissions apply', async t => {
  const f = await fixture(t); const host = await create(f); const code = host.room.code;
  const outsider = await create(f, 'Other');
  for (const route of ['', '/export']) {
    assert.equal((await f.request(`/api/rooms/${code}${route}`)).status, 401);
    assert.equal((await f.request(`/api/rooms/${code}${route}`, { token: outsider.token })).status, 401);
  }
  assert.equal((await f.request(`/api/rooms/${code}/join`, { method: 'POST', body: { name: ' HOST ' } })).status, 409);
  const join = await f.request(`/api/rooms/${code}/join`, { method: 'POST', body: { name: 'Guest' } });
  assert.equal(join.status, 201); const guest = join.data;
  assert.notEqual(guest.token, host.token);
  assert.equal((await action(f, guest, 'start', {}, 2)).status, 403);
  const ready = await action(f, guest, 'ready', { ready: true, playerId: host.participantId }, 2);
  assert.equal(ready.status, 200);
  assert.equal(ready.data.room.participants[0].ready, false); assert.equal(ready.data.room.participants[1].ready, true);
  assert.equal((await action(f, host, 'start', {}, 3)).status, 409);
});

test('actions reject stale versions; duplicate retries are durable and conflicting id reuse is rejected', async t => {
  const f = await fixture(t); const host = await create(f);
  const id = 'stable-action-123'; const result = await action(f, host, 'ready', { ready: true }, 1, id);
  assert.equal(result.status, 200); assert.equal(result.data.room.version, 2);
  assert.deepEqual((await action(f, host, 'ready', { ready: true }, 1, id)).data, result.data);
  assert.equal((await action(f, host, 'ready', { ready: false }, 1, id)).status, 409);
  assert.equal((await action(f, host, 'ready', { ready: false }, 1)).status, 409);
  await f.restart();
  assert.deepEqual((await action(f, host, 'ready', { ready: true }, 1, id)).data, result.data);
  const loaded = await f.request(`/api/rooms/${host.room.code}`, { token: host.token });
  assert.equal(loaded.status, 200); assert.equal(loaded.data.room.version, 2);
  const database = await readFile(path.join(f.dir, 'rooms.sqlite'));
  assert.equal(database.includes(Buffer.from(host.token)), false);
});

test('concurrent writes have one winner, persistence survives restart, pause freezes deadline', async t => {
  let time = 100000;
  const f = await fixture(t, { now: () => time }); const host = await create(f);
  const results = await Promise.all([action(f, host, 'ready', { ready: true }, 1), action(f, host, 'ready', { ready: false }, 1)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  let ready = await action(f, host, 'ready', { ready: true }, 2); assert.equal(ready.status, 200);
  let started = await action(f, host, 'start', {}, 3); assert.equal(started.data.room.status, 'playing');
  time += 10000;
  let paused = await action(f, host, 'pause', {}, 4); assert.equal(paused.data.room.game.remainingMs, 50000); assert.equal(paused.data.room.game.deadline, null);
  await f.restart(); time += 100000;
  const resumed = await action(f, host, 'resume', {}, 5); assert.equal(resumed.data.room.game.deadline, time + 50000);
  assert.equal((await f.request(`/api/rooms/${host.room.code}/join`, { method: 'POST', body: { name: 'Late' } })).status, 409);
});

test('browser recovery sets secure HttpOnly cookie and enforces Origin for cookie mutations', async t => {
  const f = await fixture(t, { publicOrigin: 'https://reroll.example' });
  const createResponse = await f.request('/api/rooms', { method: 'POST', body: { name: 'Host', mode: 'deal' }, headers: { Origin: 'https://reroll.example' } });
  assert.equal(createResponse.status, 201);
  const host = createResponse.data; const code = host.room.code;
  const cookie = createResponse.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /; Secure/); assert.match(cookie, new RegExp(`Path=/api/rooms/${code}`));
  const headers = { Cookie: cookie.split(';')[0] };
  assert.equal((await f.request(`/api/rooms/${code}`, { headers })).status, 200);
  const input = { id: 'cookie-action-1', version: 1, type: 'ready', payload: { ready: true } };
  assert.equal((await f.request(`/api/rooms/${code}/actions`, { method: 'POST', headers, body: input })).status, 403);
  assert.equal((await f.request(`/api/rooms/${code}/actions`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: input })).status, 403);
  assert.equal((await f.request(`/api/rooms/${code}/actions`, { method: 'POST', headers: { ...headers, Origin: 'https://reroll.example' }, body: input })).status, 200);
  assert.equal((await f.request(`/api/rooms/${code}/actions`, { method: 'POST', headers: { ...headers, Authorization: 'invalid' }, body: input })).status, 403);
  const resume = await f.request(`/api/rooms/${code}/resume`, { method: 'POST', body: { token: host.token } });
  assert.equal(resume.status, 200); assert.ok(resume.headers.get('set-cookie')); assert.equal(resume.data.token, undefined);
  assert.equal((await f.request(`/api/rooms/${code}/resume`, { method: 'POST', body: { token: 'x'.repeat(43) } })).status, 401);
});

test('validates JSON, configuration, request size, origin, and static allowlist', async t => {
  const f = await fixture(t, { bodyLimit: 1024 });
  assert.equal((await f.request('/api/rooms', { method: 'POST', body: { name: 'A', mode: 'invalid' } })).status, 400);
  assert.equal((await f.request('/api/rooms', { method: 'POST', body: { name: 'A', mode: 'draft', config: [] } })).status, 400);
  assert.equal((await f.request('/api/rooms', { method: 'POST', raw: '{bad', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.request('/api/rooms', { method: 'POST', raw: '{}' })).status, 415);
  assert.equal((await f.request('/api/rooms', { method: 'POST', body: { name: 'A'.repeat(2000), mode: 'draft' } })).status, 413);
  assert.equal((await f.request('/api/rooms', { method: 'POST', body: {}, headers: { Origin: 'https://attacker.example' } })).status, 403);
  for (const resource of ['/server/server.cjs', '/.git/config', '/docs/test', '/assets/%2e%2e%2fserver/server.cjs', '/assets/%2e%2e%2f.git/config']) assert.equal((await f.request(resource)).status, 404, resource);
  assert.equal((await f.request('/')).status, 200);
  assert.equal((await f.request('/healthz')).status, 200);
  assert.equal((await f.request('/readyz')).status, 200);
});

test('exports progress without credentials and neutralizes spreadsheet formulas', async t => {
  const f = await fixture(t); const host = await create(f, '=HYPERLINK("evil")');
  const json = await f.request(`/api/rooms/${host.room.code}/export`, { token: host.token });
  assert.equal(json.status, 200); assert.equal(json.data.status, 'lobby');
  assert.equal(JSON.stringify(json.data).includes(host.token), false);
  const csv = await f.request(`/api/rooms/${host.room.code}/export?format=csv`, { token: host.token });
  assert.equal(csv.status, 200); assert.match(csv.data, /"'=HYPERLINK/); assert.match(csv.data, /progress/);
  assert.match(csv.headers.get('content-disposition'), /progress\.csv/);
  assert.equal((await f.request(`/api/rooms/${host.room.code}/export?format=html`, { token: host.token })).status, 400);
});

test('read activity does not extend saved retention; expired rooms free bounded capacity', async t => {
  let time = 1000; const f = await fixture(t, { now: () => time, roomTtlDays: 1, maxRooms: 1 }); const host = await create(f);
  assert.equal((await f.request('/api/rooms', { method: 'POST', body: { name: 'B', mode: 'draft' } })).status, 503);
  time += 86400000 - 1;
  const read = await f.request(`/api/rooms/${host.room.code}`, { token: host.token }); assert.equal(read.status, 200); assert.equal(read.data.room.expiresAt, 86401000);
  time += 1;
  assert.equal((await f.request(`/api/rooms/${host.room.code}`, { token: host.token })).status, 404);
  await create(f, 'New host');
});

test('invalid game transitions roll back room and do not consume command ids', async t => {
  const f = await fixture(t); const host = await create(f);
  await action(f, host, 'ready', { ready: true }, 1);
  await action(f, host, 'start', {}, 2);
  const invalid = await action(f, host, 'unknown', {}, 3, 'retry-after-validation');
  assert.equal(invalid.status, 400);
  const read = await f.request(`/api/rooms/${host.room.code}`, { token: host.token });
  assert.equal(read.data.room.version, 3); assert.equal(read.data.room.game.count, 0);
  const fixed = await action(f, host, 'increment', {}, 3, 'retry-after-validation');
  assert.equal(fixed.status, 200); assert.equal(fixed.data.room.game.count, 1);
});

test('rate limiting ignores spoofed forwarded IPs and room command growth is bounded', async t => {
  const f = await fixture(t, { rateLimit: 2 }); const host = await create(f);
  assert.equal((await f.request(`/api/rooms/${host.room.code}`, { token: host.token })).status, 200);
  assert.equal((await f.request(`/api/rooms/${host.room.code}`, { token: host.token, headers: { 'X-Forwarded-For': '10.0.0.9' } })).status, 429);
  const bounded = await fixture(t, { maxCommands: 1 }); const seat = await create(bounded);
  assert.equal((await action(bounded, seat, 'ready', { ready: true }, 1, 'bounded-command')).status, 200);
  assert.equal((await action(bounded, seat, 'ready', { ready: true }, 1, 'bounded-command')).status, 200);
  assert.equal((await action(bounded, seat, 'start', {}, 2)).status, 409);
});

async function realRoom(f, mode, config = {}, count = 3) {
  const created = await f.request('/api/rooms', { method: 'POST', body: { name: 'Player 0', mode, config } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const seats = [created.data]; let room = created.data.room;
  for (let i = 1; i < count; i++) {
    const joined = await f.request(`/api/rooms/${room.code}/join`, { method: 'POST', body: { name: `Player ${i}` } });
    assert.equal(joined.status, 201); seats.push(joined.data); room = joined.data.room;
  }
  for (const seat of seats) { const ready = await action(f, seat, 'ready', { ready: true }, room.version); assert.equal(ready.status, 200); room = ready.data.room; }
  const started = await action(f, seats[0], 'start', {}, room.version); assert.equal(started.status, 200, JSON.stringify(started.data));
  return { seats, room: started.data.room };
}
const currentSeat = (room, seats) => seats.find(seat => seat.participantId === room.game.players[room.game.order[room.game.turn % room.game.order.length]].id);

test('real multiplayer draft persists selection and timer; recovery then exports authoritative results', async t => {
  let time = 100000;
  const f = await fixture(t, { game: require('../server/game.cjs'), now: () => time });
  let { room, seats } = await realRoom(f, 'draft', { order: 'manual', pickTimer: 15 });
  const actor = currentSeat(room, seats);
  assert.equal((await action(f, seats[1], 'pick', { index: 0 }, room.version)).status, 403);
  const selectedKey = room.game.offers[1].key;
  const selected = await action(f, actor, 'select', { index: 1, name: 'Saved Hero' }, room.version, 'real-draft-select');
  assert.equal(selected.status, 200); assert.ok(selected.headers.get('set-cookie'));
  room = selected.data.room;
  await f.restart();
  const replay = await action(f, actor, 'select', { index: 1, name: 'Saved Hero' }, room.version - 1, 'real-draft-select');
  assert.deepEqual(replay.data, selected.data);
  const restored = await f.request(`/api/rooms/${room.code}/resume`, { method: 'POST', body: { token: actor.token } });
  assert.equal(restored.data.room.game.pending.name, 'Saved Hero');
  time += 15000;
  const elapsed = await f.request(`/api/rooms/${room.code}`, { token: actor.token }); room = elapsed.data.room;
  assert.equal(room.game.picks[0].key, selectedKey); assert.equal(room.game.picks[0].name, 'Saved Hero');
  while (room.status !== 'done') { const picked = await action(f, currentSeat(room, seats), 'pick', { index: 0 }, room.version); assert.equal(picked.status, 200); room = picked.data.room; }
  const result = await f.request(`/api/rooms/${room.code}/export`, { token: seats[1].token });
  assert.equal(result.data.status, 'done'); assert.equal(result.data.roster.length, 3); assert.ok(result.data.roster.every(p => p.complete));
  assert.equal(new Set(result.data.roster.map(p => `${p.race}|${p.cls}`)).size, 3);
});

test('real hard guild roster completes both phases across restart with enforced role quotas', async t => {
  const f = await fixture(t, { game: require('../server/game.cjs') });
  let { room, seats } = await realRoom(f, 'draft', { order: 'manual', format: 'twostage', enforce: 'hard', requirements: { 'role:Tank': { min: 1, max: 1 }, 'role:Healer': { min: 1, max: 1 }, 'role:DPS': { min: 1, max: 1 } } });
  while (room.game.phase !== 'stage-break') { const result = await action(f, currentSeat(room, seats), 'pick', { index: 0 }, room.version); assert.equal(result.status, 200); room = result.data.room; }
  assert.equal(room.game.assignments.length, 3);
  await f.restart();
  assert.equal((await action(f, seats[1], 'begin-stage2', {}, room.version)).status, 403);
  const started = await action(f, seats[0], 'begin-stage2', {}, room.version); assert.equal(started.status, 200); room = started.data.room;
  while (room.status !== 'done') { const result = await action(f, currentSeat(room, seats), 'pick', { index: 0 }, room.version); assert.equal(result.status, 200); room = result.data.room; }
  assert.deepEqual(room.game.picks.map(p => p.role).sort(), ['DPS', 'Healer', 'Tank']);
  const csv = await f.request(`/api/rooms/${room.code}/export?format=csv`, { token: seats[0].token });
  assert.equal(csv.status, 200); assert.match(csv.data, /finished/); assert.match(csv.headers.get('content-disposition'), /results\.csv/);
});

test('real Deal Everyone persists defense, resolves a steal on the server, and exports final choices', async t => {
  const f = await fixture(t, { game: require('../server/game.cjs') });
  let { room, seats } = await realRoom(f, 'deal', { budget: 50, attempts: 1 });
  for (const seat of seats) { const result = await action(f, seat, 'defense', { allocations: [5, 0, 0] }, room.version); assert.equal(result.status, 200); room = result.data.room; }
  assert.equal(room.game.phase, 'steal'); await f.restart();
  const actor = currentSeat(room, seats);
  const actorIndex = room.game.players.findIndex(p => p.id === actor.participantId);
  const steal = await action(f, actor, 'contest', { target: (actorIndex + 1) % seats.length, slot: 0, offered: 0, bonus: 0 }, room.version, 'real-steal-idempotent');
  assert.equal(steal.status, 200, JSON.stringify(steal.data));
  const version = room.version; room = steal.data.room;
  await f.restart();
  const replay = await action(f, actor, 'contest', { target: (actorIndex + 1) % seats.length, slot: 0, offered: 0, bonus: 0 }, version, 'real-steal-idempotent');
  assert.deepEqual(replay.data, steal.data);
  while (room.game.phase === 'steal') { const result = await action(f, currentSeat(room, seats), 'pass', {}, room.version); assert.equal(result.status, 200); room = result.data.room; }
  for (const seat of seats) { const result = await action(f, seat, 'choose', { slot: 0 }, room.version); assert.equal(result.status, 200); room = result.data.room; }
  assert.equal(room.status, 'done');
  const result = await f.request(`/api/rooms/${room.code}/export`, { token: seats[2].token });
  assert.equal(result.data.roster.length, 3); assert.ok(result.data.roster.every(p => p.complete));
});

test('configured room size is enforced at admission and malformed JSON content types are refused', async t => {
  const f = await fixture(t, { game: require('../server/game.cjs') });
  const created = await f.request('/api/rooms', { method: 'POST', body: { mode: 'draft', name: 'Host', config: { maxPlayers: 1 } } });
  assert.equal(created.status, 201);
  assert.equal((await f.request(`/api/rooms/${created.data.room.code}/join`, { method: 'POST', body: { name: 'Guest' } })).status, 409);
  assert.equal((await f.request('/api/rooms', { method: 'POST', body: {}, headers: { 'Content-Type': 'application/jsonp' } })).status, 415);
});

test('host can remove abandoned lobby seats, revoking recovery and allowing a fresh same-name guest', async t => {
  const f = await fixture(t); const host = await create(f);
  const joined = await f.request(`/api/rooms/${host.room.code}/join`, { method: 'POST', body: { name: 'Guest' } }); const guest = joined.data;
  assert.equal((await action(f, guest, 'remove-player', { participantId: host.participantId }, 2)).status, 403);
  assert.equal((await action(f, host, 'remove-player', { participantId: host.participantId }, 2)).status, 400);
  const removed = await action(f, host, 'remove-player', { participantId: guest.participantId }, 2);
  assert.equal(removed.status, 200); assert.equal(removed.data.room.participants.length, 1);
  for (const route of ['', '/export']) assert.equal((await f.request(`/api/rooms/${host.room.code}${route}`, { token: guest.token })).status, 401);
  assert.equal((await f.request(`/api/rooms/${host.room.code}/resume`, { method: 'POST', body: { token: guest.token } })).status, 401);
  const replacement = await f.request(`/api/rooms/${host.room.code}/join`, { method: 'POST', body: { name: 'Guest' } });
  assert.equal(replacement.status, 201); assert.notEqual(replacement.data.participantId, guest.participantId); assert.notEqual(replacement.data.token, guest.token);
});

test('production fails closed on missing or insecure public origin', () => {
  const prior = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => createApp({ game, publicOrigin: 'http://example.com' }), /HTTPS/);
    assert.throws(() => createApp({ game, publicOrigin: 'https://example.com/path' }), /exact URL origin/);
  } finally { if (prior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior; }
});

test('unexpected game failures return 500, are logged, and roll back without consuming the action id', async t => {
  let failAction = true;
  const failingGame = { ...game, act(room, actor, type) {
    room.game.count += 100;
    if (failAction) throw new TypeError('Unexpected engine implementation failure');
    room.game.count -= 100;
    return game.act(room, actor, type);
  } };
  const logs = t.mock.method(console, 'error', () => {});
  const f = await fixture(t, { game: failingGame }); const host = await create(f);
  await action(f, host, 'ready', { ready: true }, 1);
  await action(f, host, 'start', {}, 2);
  const failed = await action(f, host, 'increment', {}, 3, 'unexpected-error-retry');
  assert.equal(failed.status, 500); assert.deepEqual(failed.data, { error: 'Internal server error' });
  assert.equal(logs.mock.callCount(), 1); assert.equal(logs.mock.calls[0].arguments[1], 'TypeError');
  const loaded = await f.request(`/api/rooms/${host.room.code}`, { token: host.token });
  assert.equal(loaded.data.room.version, 3); assert.equal(loaded.data.room.game.count, 0);
  failAction = false;
  const retry = await action(f, host, 'increment', {}, 3, 'unexpected-error-retry');
  assert.equal(retry.status, 200); assert.equal(retry.data.room.game.count, 1);
});

test('readiness reports false with 503 when storage health fails', async t => {
  const f = await fixture(t);
  f.store.healthy = () => false;
  const response = await f.request('/readyz');
  assert.equal(response.status, 503); assert.deepEqual(response.data, { ready: false });
});

test('metrics expose fixed operational gauges without private room data', async t => {
  const f = await fixture(t); const seat = await create(f, 'Private Guest');
  const response = await f.request('/metrics');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
  assert.match(response.data, /^war_table_ready 1$/m);
  assert.match(response.data, /^process_uptime_seconds [0-9.]+$/m);
  assert.match(response.data, /^process_resident_memory_bytes [0-9]+$/m);
  for (const privateValue of [seat.room.code, seat.token, seat.participantId, 'Private Guest']) assert.equal(response.data.includes(privateValue), false);
  assert.equal(response.data.split('\n').filter(line => line && !line.startsWith('#')).length, 3);
  assert.equal((await f.request('/metrics', { method: 'POST' })).status, 405);
  f.store.healthy = () => false;
  assert.match((await f.request('/metrics')).data, /^war_table_ready 0$/m);
});
