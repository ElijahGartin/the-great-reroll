'use strict';

const { randomInt } = require('node:crypto');
const DATA = require('../data/characters.js');
const DEAL = require('../js/deal-engine.js');
const ROLES = DATA.ROLES;
const FACTIONS = { Horde: DATA.HORDE, Alliance: DATA.ALLIANCE };
const random = () => randomInt(0x100000000) / 0x100000000;
const clone = value => structuredClone(value);

function check(condition, message, statusCode = 400) {
  if (!condition) throw Object.assign(new Error(message), { statusCode });
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function number(value, fallback, min, max, name) {
  const result = value === undefined ? fallback : value;
  check(Number.isInteger(result) && result >= min && result <= max, `${name} must be a whole number from ${min} to ${max}.`);
  return result;
}
function option(value, fallback, choices, name) {
  const result = value === undefined ? fallback : value;
  check(choices.includes(result), `Invalid ${name}.`);
  return result;
}
function shuffle(values, rng = random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function allCards(faction) {
  return Object.entries(FACTIONS[faction]).flatMap(([race, classes]) => classes.map(cls => ({ faction, race, cls, key: `${race}|${cls}` })));
}
function pool(config, faction) {
  const enabled = new Set(config.eligibility[faction]);
  return allCards(faction).filter(card => enabled.has(card.key));
}

function normalizeConfig(mode, input = {}) {
  check(['draft', 'deal'].includes(mode), 'Choose a supported game mode.');
  check(object(input), 'Configuration must be an object.');
  const config = {
    faction: option(input.faction, 'Horde', ['Horde', 'Alliance', 'Either'], 'faction'),
    maxPlayers: number(input.maxPlayers, 40, 1, 40, 'Player limit'),
    eligibility: {},
  };
  check(input.eligibility === undefined || object(input.eligibility), 'Eligibility must contain faction lists.');
  for (const faction of Object.keys(FACTIONS)) {
    const keys = allCards(faction).map(card => card.key);
    const selected = input.eligibility?.[faction] ?? keys;
    check(Array.isArray(selected) && selected.length <= keys.length && selected.every(key => typeof key === 'string' && keys.includes(key)), 'Invalid character pool.');
    check(new Set(selected).size === selected.length, 'The character pool contains duplicates.');
    config.eligibility[faction] = [...selected];
  }
  if (mode === 'deal') {
    config.budget = number(input.budget, 50, 0, 1000, 'Bonus points');
    config.attempts = number(input.attempts, 1, 0, 5, 'Steal attempts');
    return config;
  }
  Object.assign(config, {
    format: option(input.format, 'class', ['class', 'spec', 'twostage'], 'draft format'),
    options: number(input.options, 3, 1, 5, 'Choices'),
    stageTwoOptions: number(input.stageTwoOptions, 3, 1, 5, 'Stage two choices'),
    duplicates: option(input.duplicates, 'unique', ['unique', 'repeat'], 'duplicate setting'),
    order: option(input.order, 'roll', ['roll', 'random', 'manual'], 'turn order'),
    pickTimer: number(input.pickTimer, 0, 0, 300, 'Pick timer'),
    enforce: option(input.enforce, 'soft', ['none', 'soft', 'hard'], 'requirement enforcement'),
    requirements: {},
  });
  if (config.format !== 'twostage') config.enforce = 'none';
  check(input.requirements === undefined || object(input.requirements), 'Requirements must be an object.');
  const known = [...ROLES.map(role => `role:${role}`), ...Object.keys(DATA.CLASS_SPECS).map(cls => `class:${cls}`)];
  for (const [key, value] of Object.entries(input.requirements || {})) {
    check(known.includes(key) && object(value), 'Unknown roster requirement.');
    const min = number(value.min, 0, 0, 40, 'Minimum');
    const max = number(value.max, 0, 0, 40, 'Maximum');
    check(!max || min <= max, 'A minimum cannot exceed its maximum.');
    check(!(config.enforce === 'hard' && key.startsWith('class:') && (min || max)), 'Hard roster requirements apply to roles; use soft requirements for class targets.');
    config.requirements[key] = { min, max };
  }
  return config;
}

// Feasible circulation with lower bounds. This proves that every locked path can
// receive a distinct card and future players can meet the remaining role quotas.
// Unlike checking each player independently, it detects competing final cards.
function feasibleRoster(cards, assignments, remaining, config) {
  const count = assignments.length + remaining;
  if (!count) return true;
  if (!cards.length || (config.duplicates === 'unique' && cards.length < count)) return false;
  const edges = [];
  let next = 0;
  const source = next++, sink = next++, future = next++;
  const roles = ROLES.map(() => next++);
  const cardNodes = cards.map(() => next++);
  const assignedNodes = assignments.map(() => next++);
  const add = (a, b, low, high) => edges.push([a, b, low, high]);
  cards.forEach((card, i) => add(cardNodes[i], sink, 0, config.duplicates === 'unique' ? 1 : count));
  assignments.forEach((assignment, i) => {
    add(source, assignedNodes[i], 1, 1);
    cards.forEach((card, j) => {
      if (card.race === assignment.race && DATA.CLASS_SPECS[card.cls].some(([, role]) => role === assignment.role)) add(assignedNodes[i], cardNodes[j], 0, 1);
    });
  });
  add(source, future, remaining, remaining);
  for (const [i, role] of ROLES.entries()) {
    const locked = assignments.filter(a => a.role === role).length;
    const target = config.enforce === 'hard' ? config.requirements[`role:${role}`] || {} : {};
    if (target.max && locked > target.max) return false;
    const lower = Math.max(0, (target.min || 0) - locked);
    const upper = Math.min(remaining, target.max ? target.max - locked : remaining);
    if (lower > upper) return false;
    add(future, roles[i], lower, upper);
    cards.forEach((card, j) => {
      if (DATA.CLASS_SPECS[card.cls].some(([, supported]) => supported === role)) add(roles[i], cardNodes[j], 0, count);
    });
  }
  add(sink, source, 0, count);
  const superSource = next++, superSink = next++;
  const graph = Array.from({ length: next }, () => []), balance = new Array(next).fill(0);
  function residual(a, b, capacity) {
    graph[a].push({ to: b, rev: graph[b].length, capacity });
    graph[b].push({ to: a, rev: graph[a].length - 1, capacity: 0 });
  }
  for (const [a, b, lower, upper] of edges) {
    residual(a, b, upper - lower); balance[a] -= lower; balance[b] += lower;
  }
  let required = 0, sent = 0;
  for (let i = 0; i < superSource; i++) {
    if (balance[i] > 0) { residual(superSource, i, balance[i]); required += balance[i]; }
    else if (balance[i] < 0) residual(i, superSink, -balance[i]);
  }
  while (sent < required) {
    const parent = new Array(next).fill(null), queue = [superSource];
    parent[superSource] = [-1, -1];
    for (let q = 0; q < queue.length && !parent[superSink]; q++) {
      const node = queue[q];
      graph[node].forEach((edge, index) => {
        if (edge.capacity > 0 && !parent[edge.to]) { parent[edge.to] = [node, index]; queue.push(edge.to); }
      });
    }
    if (!parent[superSink]) return false;
    let amount = required - sent;
    for (let node = superSink; node !== superSource;) { const [from, index] = parent[node]; amount = Math.min(amount, graph[from][index].capacity); node = from; }
    for (let node = superSink; node !== superSource;) {
      const [from, index] = parent[node], edge = graph[from][index];
      edge.capacity -= amount; graph[node][edge.rev].capacity += amount; node = from;
    }
    sent += amount;
  }
  return true;
}

function roleVariants(cards) {
  const found = new Map();
  for (const card of cards) for (const [, role] of DATA.CLASS_SPECS[card.cls]) {
    const key = `${card.race}|${role}`;
    if (!found.has(key)) found.set(key, { faction: card.faction, race: card.race, role, cls: '', spec: '', key });
  }
  return [...found.values()];
}
function legalOptions(game) {
  const config = game.config, cards = pool(config, game.faction);
  const used = new Set(game.picks.map(pick => pick.key));
  const available = cards.filter(card => config.duplicates === 'repeat' || !used.has(card.key));
  if (config.format !== 'twostage') {
    return config.format === 'spec'
      ? available.flatMap(card => DATA.CLASS_SPECS[card.cls].map(([spec, role]) => ({ ...card, spec, role })))
      : available.map(card => ({ ...card, spec: '', role: '' }));
  }
  if (game.stage === 1) {
    return roleVariants(cards).filter(candidate => feasibleRoster(cards, [...game.assignments, candidate], game.players.length - game.assignments.length - 1, config));
  }
  const assignment = game.assignments[game.turn];
  return available.filter(card => card.race === assignment.race).flatMap(card => DATA.CLASS_SPECS[card.cls]
    .filter(([, role]) => role === assignment.role)
    .map(([spec, role]) => ({ ...card, spec, role })))
    .filter(candidate => feasibleRoster(
      available.filter(card => config.duplicates === 'repeat' || card.key !== candidate.key),
      game.assignments.slice(game.turn + 1), 0, { ...config, enforce: 'none' },
    ));
}
function dealOffers(game, now) {
  let candidates = shuffle(legalOptions(game));
  if (game.config.format !== 'twostage') {
    const seen = new Set(); candidates = candidates.filter(card => !seen.has(card.key) && seen.add(card.key));
  }
  const count = game.stage === 2 ? game.config.stageTwoOptions : game.config.options;
  check(candidates.length > 0, 'No valid choices remain for this turn.');
  if (game.config.format !== 'twostage') check(candidates.length >= count, 'Not enough distinct choices remain.');
  game.offers = candidates.slice(0, count); game.pending = null;
  game.deadline = game.config.pickTimer ? now + game.config.pickTimer * 1000 : null;
}
function rollOrder(players) {
  const rolls = players.map(player => ({ playerId: player.id, name: player.name, history: [randomInt(1, 101)] }));
  for (let round = 0; round < 100; round++) {
    const groups = new Map();
    rolls.forEach(roll => { const key = roll.history.join(','); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(roll); });
    const ties = [...groups.values()].filter(group => group.length > 1);
    if (!ties.length) break;
    ties.forEach(group => group.forEach(roll => roll.history.push(randomInt(1, 101))));
    check(round < 99, 'Unable to resolve dice order. Please start again.');
  }
  const order = players.map((_, i) => i).sort((a, b) => {
    for (let i = 0; i < Math.max(rolls[a].history.length, rolls[b].history.length); i++) {
      const difference = (rolls[b].history[i] || 0) - (rolls[a].history[i] || 0);
      if (difference) return difference;
    }
    return 0;
  });
  return { rolls, order };
}
function validatePool(mode, config, faction, count) {
  const cards = pool(config, faction);
  if (mode === 'deal') check(cards.length >= count * 3, `${faction} needs ${count * 3} eligible characters for ${count} players; it has ${cards.length}.`);
  else if (config.format === 'twostage') {
    check(roleVariants(cards).length >= config.options, `Enable more ${faction} race/role choices or reduce the number of choices.`);
    check(feasibleRoster(cards, [], count, config), `The ${faction} character pool cannot satisfy all players and role requirements.`);
  } else check(cards.length >= (config.duplicates === 'unique' ? count + config.options - 1 : config.options), `Enable more ${faction} characters, allow repeats, or reduce players/choices.`);
}

function start(room, now = Date.now()) {
  check(room.status === 'lobby', 'The room has already started.');
  check(room.participants.length > 0 && room.participants.length <= 40, 'Choose 1–40 players.');
  const config = normalizeConfig(room.mode, room.config), players = room.participants.map(({ id, name }) => ({ id, name }));
  check(players.length <= config.maxPlayers, 'The room is full.');
  const factions = config.faction === 'Either' ? ['Horde', 'Alliance'] : [config.faction];
  factions.forEach(faction => validatePool(room.mode, config, faction, players.length));
  const faction = factions[randomInt(factions.length)];
  let game;
  if (room.mode === 'deal') {
    game = DEAL.create(players.map(player => player.name), pool(config, faction), config.budget, config.attempts, random);
    game.players.forEach((player, index) => { player.id = players[index].id; });
    Object.assign(game, { mode: 'deal', faction, config, submissions: {}, deadline: null });
  } else {
    const rolled = config.order === 'roll' ? rollOrder(players) : { rolls: [], order: config.order === 'random' ? shuffle(players.map((_, i) => i)) : players.map((_, i) => i) };
    game = { mode: 'draft', phase: 'draft', faction, config, players, ...rolled, turn: 0, stage: 1, assignments: [], picks: [], offers: [], spent: [], pending: null, deadline: null };
    dealOffers(game, now);
  }
  room.game = game; room.status = 'playing';
}
function current(game) { return game.players[game.order[game.turn % game.order.length]]; }
function characterName(value) {
  const name = value === undefined ? '' : value;
  check(typeof name === 'string' && name.trim().length <= 36 && !/[\x00-\x1f\x7f]/.test(name), 'Character names must be at most 36 characters without control characters.');
  return name.trim();
}
function finishPick(room, index, name, now) {
  const game = room.game, card = game.offers[index], player = current(game);
  check(Number.isInteger(index) && card, 'Choose one of the offered cards.');
  const pick = { ...card, playerId: player.id, player: player.name, name: characterName(name) };
  if (game.config.format === 'twostage' && game.stage === 1) game.assignments.push(pick);
  else game.picks.push(pick);
  game.turn++; game.pending = null; game.deadline = null;
  if (game.turn === game.players.length) {
    game.offers = [];
    if (game.config.format === 'twostage' && game.stage === 1) game.phase = 'stage-break';
    else { game.phase = 'done'; room.status = 'done'; }
  } else dealOffers(game, now);
}
function draftAction(room, actorId, type, payload, now) {
  const game = room.game;
  if (type === 'begin-stage2') {
    check(actorId === room.hostId, 'Only the host can begin stage two.', 403);
    check(game.phase === 'stage-break', 'Stage two is not ready.');
    game.stage = 2; game.turn = 0; game.phase = 'draft'; dealOffers(game, now); return;
  }
  check(game.phase === 'draft', 'This draft phase is not accepting picks.');
  check(current(game).id === actorId, 'Wait for your turn.', 403);
  if (type === 'spin') {
    check(!game.spent.includes(actorId), 'Your extra spin has already been used.');
    const count = game.stage === 2 ? game.config.stageTwoOptions : game.config.options;
    const candidates = legalOptions(game);
    const available = game.config.format === 'twostage' ? candidates.length : new Set(candidates.map(c => c.key)).size;
    check(available >= count, 'Not enough eligible choices for another full hand.');
    dealOffers(game, now); game.spent.push(actorId); return;
  }
  if (type === 'select' || type === 'pick') {
    check(Number.isInteger(payload.index) && game.offers[payload.index], 'Choose one of the offered cards.');
    const name = characterName(payload.name);
    if (type === 'select') game.pending = { index: payload.index, name };
    else finishPick(room, payload.index, name, now);
    return;
  }
  if (type === 'confirm') {
    check(game.pending !== null, 'Select a card first.');
    finishPick(room, game.pending.index, payload.name === undefined ? game.pending.name : payload.name, now); return;
  }
  check(false, 'Unknown action for a turn-based draft.');
}
function dealAction(room, actorId, type, payload) {
  const game = room.game, playerIndex = game.players.findIndex(player => player.id === actorId);
  check(playerIndex >= 0, 'You are not a player in this game.', 403);
  if (type === 'defense') {
    check(game.phase === 'defense', 'Defense is already locked.');
    check(!Object.hasOwn(game.submissions, actorId), 'Your defense is already submitted.');
    const allocation = payload.allocations;
    check(Array.isArray(allocation) && allocation.length === 3 && allocation.every(n => Number.isInteger(n) && n >= 0 && n <= game.budget) && allocation.reduce((a, b) => a + b, 0) <= game.budget, 'Assign three whole defense amounts within your budget.');
    game.submissions[actorId] = [...allocation];
    if (game.players.every(player => Object.hasOwn(game.submissions, player.id))) DEAL.lockDefense(game, game.players.map(player => game.submissions[player.id]));
  } else if (type === 'pass' || type === 'contest') {
    check(game.phase === 'steal', 'The steal round is not active.');
    check(current(game).id === actorId, 'Wait for your steal turn.', 403);
    if (type === 'pass') DEAL.pass(game);
    else {
      check(Number.isInteger(payload.target) && payload.target >= 0 && payload.target < game.players.length, 'Choose a valid target player.');
      DEAL.contest(game, payload.target, payload.slot, payload.offered, payload.bonus, random);
    }
  } else if (type === 'choose') DEAL.choose(game, playerIndex, payload.slot);
  else check(false, 'Unknown action for Deal Everyone.');
  if (game.phase === 'done') room.status = 'done';
}
function act(room, actorId, type, payload = {}, now = Date.now()) {
  check(room.status === 'playing', room.status === 'paused' ? 'The game is paused.' : 'The game is not active.');
  check(object(payload), 'Action payload must be an object.');
  // Failed actions must not partially mutate persisted or in-memory state.
  const next = { ...room, game: clone(room.game) };
  if (room.mode === 'draft') draftAction(next, actorId, type, payload, now);
  else if (room.mode === 'deal') dealAction(next, actorId, type, payload);
  else check(false, 'Unknown game mode.');
  room.game = next.game; room.status = next.status;
}
function tick(room, now = Date.now()) {
  const game = room.game;
  if (room.status !== 'playing' || room.mode !== 'draft' || game.phase !== 'draft' || game.deadline === null || game.deadline > now) return false;
  const index = game.pending?.index ?? randomInt(game.offers.length);
  act(room, current(game).id, 'pick', { index, name: game.pending?.name || '' }, now);
  return true;
}
function roster(room) {
  if (!room.game) return room.participants.map(player => ({ playerId: player.id, player: player.name, faction: '', race: '', cls: '', spec: '', role: '', name: '', complete: false }));
  const game = room.game;
  return game.players.map(player => {
    const pick = game.mode === 'deal' ? (player.choice === null ? null : player.hand[player.choice]) : game.picks.find(item => item.playerId === player.id);
    const assignment = game.mode === 'draft' ? game.assignments.find(item => item.playerId === player.id) : null;
    return { playerId: player.id, player: player.name, faction: game.faction, race: pick?.race || assignment?.race || '', cls: pick?.cls || '', spec: pick?.spec || '', role: pick?.role || assignment?.role || '', name: pick?.name || '', complete: Boolean(pick) };
  });
}

module.exports = { normalizeConfig, start, act, tick, roster };
