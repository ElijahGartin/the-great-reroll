'use strict';
const http = require('node:http');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { readFile, realpath } = require('node:fs/promises');
const path = require('node:path');
const { isIPv6 } = require('node:net');
const { createStore } = require('./store.cjs');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const hash = token => createHash('sha256').update(token).digest('hex');
const DAY = 86400000;
function positive(value, fallback) { const n = Number(value ?? fallback); if (!Number.isSafeInteger(n) || n < 1) throw new Error('Limits must be positive integers'); return n; }
function createApp(options = {}) {
  const game = options.game || require('./game.cjs');
  const now = options.now || Date.now;
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, '../.data');
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN;
  if (process.env.NODE_ENV === 'production' && !publicOrigin) throw new Error('PUBLIC_ORIGIN is required in production');
  if (process.env.NODE_ENV === 'production' && !publicOrigin?.startsWith('https://')) throw new Error('PUBLIC_ORIGIN must use HTTPS in production');
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('PUBLIC_ORIGIN must be an exact URL origin');
  const root = path.resolve(options.staticDir || path.join(__dirname, '..'));
  const ttl = positive(options.roomTtlDays ?? process.env.ROOM_TTL_DAYS, 30) * DAY;
  const maxRooms = positive(options.maxRooms ?? process.env.MAX_ROOMS, 1000);
  const maxCommands = positive(options.maxCommands ?? process.env.MAX_COMMANDS_PER_ROOM, 20000);
  const bodyLimit = positive(options.bodyLimit ?? process.env.MAX_BODY_BYTES, 16384);
  const requestLimit = positive(options.rateLimit ?? process.env.RATE_LIMIT_PER_MINUTE, 3600);
  // Rooms that never leave the lobby are cheap to create anonymously, so they expire sooner.
  const lobbyTtl = Math.min(ttl, positive(options.lobbyTtlDays ?? process.env.LOBBY_TTL_DAYS, 7) * DAY);
  const createLimit = positive(options.createLimit ?? process.env.ROOM_CREATES_PER_HOUR, 20);
  const maxDbBytes = positive(options.maxDbBytes ?? process.env.MAX_DB_BYTES, 2147483648);
  // Only replays of recent commands matter; older ids fail the room-version check anyway.
  const commandHistory = positive(options.commandHistory ?? process.env.COMMAND_HISTORY_PER_SEAT, 16);
  // 'cloudflare' trusts CF-Connecting-IP. Enable only when NetworkPolicy admits the tunnel connector alone.
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY ?? '';
  if (!['', 'cloudflare'].includes(trustProxy)) throw new Error("TRUST_PROXY must be empty or 'cloudflare'");
  const store = createStore(dataDir);
  const rates = new Map(), creates = new Map();
  let draining = false;
  const persist = room => { room.version += 1; room.updatedAt = now(); room.expiresAt = now() + (room.status === 'lobby' ? lobbyTtl : ttl); store.put(room); };
  // New rooms and lobby changes stop at 80% so games already in progress can still finish.
  function capacity(started = false) { if (store.bytes() >= (started ? maxDbBytes : Math.floor(maxDbBytes * 0.8))) fail(507, 'Storage capacity reached; try again later'); }
  function client(req) {
    const forwarded = trustProxy === 'cloudflare' ? req.headers['cf-connecting-ip'] : undefined;
    const ip = typeof forwarded === 'string' && /^[0-9a-fA-F.:]{2,45}$/.test(forwarded) ? forwarded : req.socket.remoteAddress || '';
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped || !isIPv6(ip)) return mapped ? mapped[1] : ip;
    // One IPv6 subscriber controls a whole /64, so limits apply per /64.
    const [head, tail = ''] = ip.toLowerCase().split('::'), h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
    return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t].slice(0, 4).map(part => part.replace(/^0+(?=.)/, '')).join(':') + '::/64';
  }
  // Fixed-size windows; when full, evict the oldest client instead of refusing everyone new.
  function bucket(map, key, ms) {
    let entry = map.get(key);
    if (!entry || entry.until <= now()) { map.delete(key); if (map.size >= 10000) map.delete(map.keys().next().value); entry = { n: 0, until: now() + ms }; map.set(key, entry); }
    return entry;
  }
  // Each seat sees only its own sealed Deal Everyone defense until every allocation locks.
  function view(room, viewer) {
    const game = room.game;
    if (game?.mode !== 'deal' || game.phase !== 'defense' || !game.submissions) return room;
    const submissions = Object.fromEntries(Object.entries(game.submissions).map(([id, value]) => [id, id === viewer ? value : true]));
    return { ...room, game: { ...game, submissions } };
  }
  function getRoom(code) { const room = store.get(code); if (!room || room.expiresAt <= now()) fail(404, 'Room not found or expired'); return room; }
  function tick(room) { if (room.status === 'playing' && game.tick(room, now())) persist(room); return room; }
  function name(value, room) {
    // Reject controls plus invisible/bidi formatting characters that enable look-alike guest names.
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 32 || /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value)) fail(400, 'Guest name must contain 1–32 printable characters');
    const clean = value.trim(), key = text => text.normalize('NFKC').toLowerCase();
    if (room?.participants.some(p => key(p.name) === key(clean))) fail(409, 'That guest name is already in use');
    return clean;
  }
  function seat(room, guestName) {
    const participant = { id: randomUUID(), name: guestName, ready: false };
    const token = randomBytes(32).toString('base64url');
    room.participants.push(participant);
    store.put(room);
    store.seat(room.code, hash(token), participant.id);
    return { room, participantId: participant.id, token };
  }
  function credential(req, code) { return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1] || (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`gr_${code}=`))?.slice(code.length + 4); }
  function authenticate(req, code) {
    const token = credential(req, code);
    const id = token && store.authenticate(code, hash(token));
    if (!id) fail(401, 'A valid room seat token is required');
    return id;
  }
  function origin(req) {
    if (!req.headers.origin) {
      if (req.headers.cookie && !/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization || '')) fail(403, 'Origin is required for cookie-authenticated changes');
      return;
    }
    const expected = publicOrigin || `http://${req.headers.host}`;
    if (req.headers.origin !== expected) fail(403, 'Origin is not allowed');
  }
  async function body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'Use application/json');
    if (Number(req.headers['content-length']) > bodyLimit) fail(413, 'Request is too large');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > bodyLimit) fail(413, 'Request is too large'); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object');
    return value;
  }
  function send(res, status, value, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
  }
  function cookie(res, code, token) {
    res.setHeader('Set-Cookie', `gr_${code}=${token}; Path=/api/rooms/${code}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${publicOrigin?.startsWith('https:') ? '; Secure' : ''}`);
  }
  function act(room, actor, input) {
    if (!Number.isSafeInteger(input.version) || input.version !== room.version) fail(409, 'Room changed; refresh before trying again');
    if (typeof input.type !== 'string' || !input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) fail(400, 'Action type and payload are required');
    const host = () => { if (room.hostId !== actor) fail(403, 'Only the host can do that'); };
    const payload = input.payload;
    switch (input.type) {
      case 'ready':
        if (room.status !== 'lobby' || typeof payload.ready !== 'boolean') fail(400, 'Ready is available only in the lobby');
        room.participants.find(p => p.id === actor).ready = payload.ready;
        break;
      case 'start':
        host(); if (room.status !== 'lobby' || !room.participants.every(p => p.ready)) fail(409, 'Everyone must be ready in the lobby');
        game.start(room, now()); break;
      case 'remove-player':
        host(); if (room.status !== 'lobby') fail(409, 'Players can only be removed in the lobby');
        if (payload.participantId === room.hostId || !room.participants.some(p => p.id === payload.participantId)) fail(400, 'Choose a guest participant to remove');
        room.participants = room.participants.filter(p => p.id !== payload.participantId);
        store.removeParticipant(room.code, payload.participantId); break;
      case 'transfer-host':
        host(); if (!room.participants.some(p => p.id === payload.participantId)) fail(400, 'Participant not found');
        room.hostId = payload.participantId; break;
      case 'pause':
        host(); if (room.status !== 'playing') fail(409, 'Game is not playing');
        room.game.remainingMs = room.game.deadline == null ? null : Math.max(0, room.game.deadline - now()); room.game.deadline = null; room.status = 'paused'; break;
      case 'resume':
        host(); if (room.status !== 'paused') fail(409, 'Game is not paused');
        room.game.deadline = room.game.remainingMs == null ? null : now() + room.game.remainingMs; delete room.game.remainingMs; room.status = 'playing'; break;
      default:
        if (room.status !== 'playing') fail(409, 'Game is not playing');
        game.act(room, actor, input.type, payload, now());
    }
    persist(room);
  }
  function csv(rows) {
    const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const cell = value => { let s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); if (/^[\s]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"', '""')}"`; };
    return [keys.map(cell).join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
  }
  async function serveStatic(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Method not allowed');
    let relative; try { relative = decodeURIComponent(url.pathname).slice(1) || 'index.html'; } catch { fail(400, 'Invalid path'); }
    if (!/^(index\.html|online\.html|how-to-play\.html|(?:asset|project)-manifest\.json|(?:css|js|data|assets)\/[A-Za-z0-9_./ -]+)$/.test(relative) || relative.split('/').some(p => p.startsWith('.')) || relative.includes('\\')) fail(404, 'Not found');
    const target = path.resolve(root, relative);
    let resolved; try { resolved = await realpath(target); } catch { fail(404, 'Not found'); }
    if (!resolved.startsWith(root + path.sep)) fail(404, 'Not found');
    let content; try { content = await readFile(resolved); } catch { fail(404, 'Not found'); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
    res.writeHead(200, { 'Content-Type': types[path.extname(relative)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
    res.end(req.method === 'HEAD' ? undefined : content);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      // Proxies may route on the decoded-but-unnormalized path, so only canonical paths are served.
      const raw = (req.url || '').split('?')[0];
      if (!raw.startsWith('/') || /%2e|%2f|%5c|\\/i.test(raw) || /(^|\/)\.{1,2}(\/|$)/.test(raw)) fail(404, 'Not found');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== raw) fail(404, 'Not found');
      if (url.pathname === '/online.html') res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      if (publicOrigin?.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      if (url.pathname === '/metrics') {
        if (req.method !== 'GET') fail(405, 'Method not allowed');
        // Fixed-cardinality operational gauges only: no room, player, token, or URL labels.
        return send(res, 200, [
          '# HELP war_table_ready Whether this process can serve persisted games.',
          '# TYPE war_table_ready gauge',
          `war_table_ready ${!draining && store.healthy() ? 1 : 0}`,
          '# HELP process_uptime_seconds Seconds since process startup.',
          '# TYPE process_uptime_seconds gauge',
          `process_uptime_seconds ${process.uptime()}`,
          '# HELP process_resident_memory_bytes Resident memory size in bytes.',
          '# TYPE process_resident_memory_bytes gauge',
          `process_resident_memory_bytes ${process.memoryUsage().rss}`,
          '',
        ].join('\n'), 'text/plain; version=0.0.4; charset=utf-8');
      }
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (url.pathname === '/readyz') { const ready = !draining && store.healthy(); return send(res, ready ? 200 : 503, { ready }); }
      if (draining) fail(503, 'Server is shutting down');
      if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res, url);
      const ip = client(req);
      if (++bucket(rates, ip, 60000).n > requestLimit) fail(429, 'Too many requests');
      if (req.method === 'POST') origin(req);
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const quota = bucket(creates, ip, 3600000);
        if (quota.n >= createLimit) fail(429, 'Too many rooms created; try again later');
        const input = await body(req);
        const config = game.normalizeConfig(input.mode, input.config === undefined ? {} : input.config);
        const guest = name(input.name);
        quota.n += 1;
        return send(res, 201, store.transaction(() => {
          store.prune(now()); if (store.count() >= maxRooms) fail(503, 'Room capacity reached'); capacity();
          let code; do { code = randomBytes(5).toString('hex').toUpperCase(); } while (store.get(code));
          const room = { code, mode: input.mode, version: 0, status: 'lobby', hostId: null, participants: [], config, game: null, createdAt: now(), updatedAt: now(), expiresAt: now() + ttl };
          const result = seat(room, guest); room.hostId = result.participantId; persist(room); cookie(res, room.code, result.token); return result;
        }));
      }
      const match = /^\/api\/rooms\/([A-Z0-9]{8,10})(?:\/(join|actions|export|resume))?$/.exec(url.pathname);
      if (!match) fail(404, 'Not found');
      const [, code, route] = match;
      if (req.method === 'POST' && route === 'join') {
        const input = await body(req);
        return send(res, 201, store.transaction(() => {
          const room = getRoom(code); if (room.status !== 'lobby') fail(409, 'This game has already started');
          if (room.participants.length >= Math.min(40, room.config.maxPlayers || 40)) fail(409, 'Room is full'); capacity();
          const result = seat(room, name(input.name, room)); persist(room); cookie(res, code, result.token); return result;
        }));
      }
      if (req.method === 'POST' && route === 'resume') {
        const input = await body(req);
        if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) fail(401, 'Invalid recovery code');
        const participantId = store.authenticate(code, hash(input.token));
        if (!participantId) fail(401, 'Invalid recovery code');
        const room = store.transaction(() => tick(getRoom(code)));
        cookie(res, code, input.token); return send(res, 200, { room: view(room, participantId), participantId });
      }
      const actor = authenticate(req, code);
      if (req.method === 'GET' && !route) return send(res, 200, store.transaction(() => ({ room: view(tick(getRoom(code)), actor), participantId: actor })));
      if (req.method === 'POST' && route === 'actions') {
        const input = await body(req);
        if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.id)) fail(400, 'An action id is required');
        return send(res, 200, store.transaction(() => {
          const room = getRoom(code);
          const serialized = JSON.stringify(input);
          const previous = store.command(code, actor, input.id);
          if (previous) { if (previous.body !== serialized) fail(409, 'Action id was already used for a different request'); const prior = JSON.parse(previous.response); return { ...prior, room: view(prior.room, actor) }; }
          const used = room.actions ?? store.commandCount(code);
          if (used >= maxCommands) fail(409, 'Room action limit reached; export this game');
          capacity(room.status !== 'lobby'); room.actions = used + 1;
          tick(room); act(room, actor, input);
          const response = { room: view(room, actor), participantId: actor }; store.record(code, actor, input.id, serialized, response); store.trim(code, actor, commandHistory); cookie(res, code, credential(req, code)); return response;
        }));
      }
      if (req.method === 'GET' && route === 'export') {
        const room = store.transaction(() => tick(getRoom(code)));
        const format = url.searchParams.get('format') || 'json'; if (!['json', 'csv'].includes(format)) fail(400, 'Export format must be json or csv');
        const rows = game.roster(room);
        res.setHeader('Content-Disposition', `attachment; filename="reroll-${code}-${room.status === 'done' ? 'results' : 'progress'}.${format}"`);
        if (format === 'csv') return send(res, 200, csv(rows.map(row => ({ ...row, exportStatus: room.status === 'done' ? 'finished' : 'progress' }))), 'text/csv; charset=utf-8');
        return send(res, 200, { code, mode: room.mode, status: room.status, exportedAt: now(), config: room.config, roster: rows });
      }
      fail(405, 'Method not allowed');
    } catch (error) {
      const requestedStatus = error.statusCode ?? error.status;
      const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599 ? requestedStatus : 500;
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal server error' : error.message }); else res.destroy();
      if (status === 500) console.error('Request failed:', error.name, error.message);
    }
  });
  server.maxConnections = 1000; server.setTimeout(15000);
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 1000;
  const timer = setInterval(() => {
    try { store.transaction(() => { store.prune(now()); for (const room of store.active()) tick(room); }); for (const map of [rates, creates]) for (const [ip, rate] of map) if (rate.until <= now()) map.delete(ip); } catch (error) { console.error('Persistence maintenance failed:', error.message); }
  }, 1000); timer.unref();
  let closed;
  function close() {
    if (closed) return closed;
    draining = true; clearInterval(timer);
    closed = new Promise((resolve, reject) => { server.close(error => { store.close(); if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve(); }); server.closeIdleConnections(); });
    return closed;
  }
  return { server, close, store };
}
if (require.main === module) {
  const app = createApp(); const port = positive(process.env.PORT, 3000);
  app.server.listen(port, '0.0.0.0', () => console.log(`The Great Reroll listening on port ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { const timeout = setTimeout(() => process.exit(1), 15000); timeout.unref(); app.close().then(() => { clearTimeout(timeout); process.exit(0); }).catch(() => process.exit(1)); });
}
module.exports = { createApp };
