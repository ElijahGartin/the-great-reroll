'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../server/game.cjs');

function room(mode = 'draft', config = {}, count = 3) {
  return { mode, status: 'lobby', hostId: 'p0', participants: Array.from({ length: count }, (_, i) => ({ id: 'p' + i, name: 'Player ' + i })), config: G.normalizeConfig(mode, { order: 'manual', ...config }) };
}
const actor = r => r.game.players[r.game.order[r.game.turn % r.game.order.length]].id;
function finishDraft(r) {
  while (r.status !== 'done') {
    if (r.game.phase === 'stage-break') G.act(r, r.hostId, 'begin-stage2', {}, 1000);
    else G.act(r, actor(r), 'pick', { index: 0, name: 'Hero' }, 1000);
  }
}

test('configuration rejects invalid modes, limits and unknown eligibility keys', () => {
  assert.throws(() => G.normalizeConfig('unknown', {}));
  for (const config of [{ options: 0 }, { pickTimer: -1 }, { faction: 'evil' }, { eligibility: { Horde: ['Fake|Mage'] } }, { options: '3' }]) assert.throws(() => room('draft', config));
  assert.throws(() => room('deal', { budget: 1001 }));
});

test('lottery produces complete unique authoritative selections', () => {
  const r = room(); G.start(r, 1000);
  while (r.status !== 'done') {
    assert.equal(r.game.offers.length, 3);
    assert.equal(new Set(r.game.offers.map(c => c.key)).size, 3);
    G.act(r, actor(r), 'pick', { index: 0 }, 1000);
  }
  assert.equal(new Set(r.game.picks.map(c => c.key)).size, 3);
  assert.equal(G.roster(r).length, 3);
});

test('wrong actor, invalid index and cross-mode commands leave state unchanged', () => {
  const r = room(); G.start(r, 1000);
  for (const [id, type, payload] of [['p1', 'pick', { index: 0 }], ['p0', 'pick', { index: 99 }], ['p0', 'defense', { allocations: [0, 0, 0] }]]) {
    const before = JSON.stringify(r);
    assert.throws(() => G.act(r, id, type, payload, 1000));
    assert.equal(JSON.stringify(r), before);
  }
});

test('draft resumes a serialized pending selection and expiry commits it only once', () => {
  const r = room('draft', { pickTimer: 15 }); G.start(r, 1000);
  G.act(r, 'p0', 'select', { index: 1, name: 'Remembered' }, 2000);
  const chosen = r.game.offers[1].key, restored = JSON.parse(JSON.stringify(r));
  assert.equal(G.tick(restored, 15999), false);
  assert.equal(G.tick(restored, 16000), true);
  assert.equal(restored.game.picks[0].key, chosen);
  assert.equal(restored.game.picks[0].name, 'Remembered');
  assert.equal(G.tick(restored, 16000), false);
});

test('pause prevents timer and player commands', () => {
  const r = room('draft', { pickTimer: 15 }); G.start(r, 1000); r.status = 'paused';
  assert.equal(G.tick(r, 90000), false);
  assert.throws(() => G.act(r, 'p0', 'pick', { index: 0 }, 90000));
});

test('one extra spin per player persists across both roster stages', () => {
  const r = room('draft', { format: 'twostage', pickTimer: 15 }); G.start(r, 1000);
  G.act(r, 'p0', 'spin', {}, 2000);
  assert.equal(r.game.deadline, 17000);
  assert.throws(() => G.act(r, 'p0', 'spin', {}, 2000));
  while (r.game.phase !== 'stage-break') G.act(r, actor(r), 'pick', { index: 0 }, 2000);
  assert.throws(() => G.act(r, 'p1', 'begin-stage2', {}, 2000));
  G.act(r, 'p0', 'begin-stage2', {}, 2000);
  assert.throws(() => G.act(r, 'p0', 'spin', {}, 2000));
  finishDraft(r);
  for (const pick of r.game.picks) {
    const assignment = r.game.assignments.find(a => a.playerId === pick.playerId);
    assert.equal(pick.race, assignment.race); assert.equal(pick.role, assignment.role);
  }
});

test('hard roles and unique combinations remain feasible through both stages', () => {
  for (let run = 0; run < 20; run++) {
    const r = room('draft', { format: 'twostage', enforce: 'hard', requirements: { 'role:Tank': { min: 1, max: 1 }, 'role:Healer': { min: 1, max: 1 }, 'role:DPS': { min: 1, max: 1 } } });
    G.start(r, 1000); finishDraft(r);
    assert.equal(new Set(r.game.picks.map(p => p.role)).size, 3);
    assert.equal(new Set(r.game.picks.map(p => p.key)).size, 3);
  }
});

test('restricted roster pool never assigns two players to the sole compatible card', () => {
  const config = { format: 'twostage', options: 1, stageTwoOptions: 1, eligibility: { Horde: ['Tauren|Druid', 'Orc|Mage'] } };
  for (let run = 0; run < 20; run++) {
    const r = room('draft', config, 2); G.start(r, 1000); finishDraft(r);
    assert.equal(new Set(r.game.picks.map(p => p.key)).size, 2);
  }
});

test('impossible role targets and insufficient deals fail before launch', () => {
  const r = room('draft', { format: 'twostage', enforce: 'hard', requirements: { 'role:Tank': { min: 4, max: 4 } } });
  assert.throws(() => G.start(r, 1000)); assert.equal(r.status, 'lobby');
  assert.throws(() => G.start(room('deal', {}, 40), 1000));
});

test('Deal Everyone independently locks defense, authorizes steals and exports choices', () => {
  const r = room('deal'); G.start(r, 1000);
  assert.throws(() => G.act(r, 'p0', 'defense', { allocations: [51, 0, 0] }, 1000));
  for (const p of r.participants) G.act(r, p.id, 'defense', { allocations: [10, 0, 0] }, 1000);
  assert.equal(r.game.phase, 'steal');
  assert.throws(() => G.act(r, actor(r), 'defense', { allocations: [0, 0, 0] }, 1000));
  while (r.game.phase === 'steal') G.act(r, actor(r), 'pass', {}, 1000);
  for (const p of r.participants) G.act(r, p.id, 'choose', { slot: 0 }, 1000);
  assert.equal(r.status, 'done');
  assert.equal(new Set(G.roster(r).map(p => p.race + '|' + p.cls)).size, 3);
});

test('Either chooses a single common faction, and server-generated D100 order is stable on serialization', () => {
  const r = room('draft', { faction: 'Either', order: 'roll' }); G.start(r, 1000);
  assert.ok(['Horde', 'Alliance'].includes(r.game.faction));
  assert.equal(r.game.rolls.length, 3);
  assert.ok(r.game.rolls.every(p => p.history.every(n => Number.isInteger(n) && n >= 1 && n <= 100)));
  const snapshot = JSON.stringify(r.game);
  assert.equal(JSON.stringify(JSON.parse(snapshot)), snapshot);
});
