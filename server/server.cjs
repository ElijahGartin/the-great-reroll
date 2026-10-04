'use strict';
const http = require('node:http');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { readFile, realpath } = require('node:fs/promises');
const path = require('node:path');
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
  const store = createStore(dataDir);
  const rates = new Map();
  let draining = false;
  const persist = room => { room.version += 1; room.updatedAt = now(); room.expiresAt = now() + ttl; store.put(room); };
  function getRoom(code) { const room = store.get(code); if (!room || room.expiresAt <= now()) fail(404, 'Room not found or expired'); return room; }
  function tick(room) { if (room.status === 'playing' && game.tick(room, now())) persist(room); return room; }
  function name(value, room) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 32 || /[\x00-\x1f\x7f]/.test(value)) fail(400, 'Guest name must contain 1–32 printable characters');
    const clean = value.trim();
    if (room?.participants.some(p => p.name.toLowerCase() === clean.toLowerCase())) fail(409, 'That guest name is already in use');
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
    if (!/^(index\.html|online\.html|(?:asset|project)-manifest\.json|(?:css|js|data|assets)\/[A-Za-z0-9_./ -]+)$/.test(relative) || relative.split('/').some(p => p.startsWith('.')) || relative.includes('\\')) fail(404, 'Not found');
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
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
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
      const ip = req.socket.remoteAddress;
      let rate = rates.get(ip); if (!rate || rate.until <= now()) { if (rates.size >= 10000 && !rates.has(ip)) fail(429, 'Too many clients'); rate = { n: 0, until: now() + 60000 }; rates.set(ip, rate); }
      if (++rate.n > requestLimit) fail(429, 'Too many requests');
      if (req.method === 'POST') origin(req);
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const input = await body(req);
        const config = game.normalizeConfig(input.mode, input.config === undefined ? {} : input.config);
        const guest = name(input.name);
        return send(res, 201, store.transaction(() => {
          store.prune(now()); if (store.count() >= maxRooms) fail(503, 'Room capacity reached');
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
          if (room.participants.length >= Math.min(40, room.config.maxPlayers || 40)) fail(409, 'Room is full');
          const result = seat(room, name(input.name, room)); persist(room); cookie(res, code, result.token); return result;
        }));
      }
      if (req.method === 'POST' && route === 'resume') {
        const input = await body(req);
        if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) fail(401, 'Invalid recovery code');
        const participantId = store.authenticate(code, hash(input.token));
        if (!participantId) fail(401, 'Invalid recovery code');
        const room = store.transaction(() => tick(getRoom(code)));
        cookie(res, code, input.token); return send(res, 200, { room, participantId });
      }
      const actor = authenticate(req, code);
      if (req.method === 'GET' && !route) return send(res, 200, store.transaction(() => ({ room: tick(getRoom(code)), participantId: actor })));
      if (req.method === 'POST' && route === 'actions') {
        const input = await body(req);
        if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.id)) fail(400, 'An action id is required');
        return send(res, 200, store.transaction(() => {
          const room = getRoom(code);
          const serialized = JSON.stringify(input);
          const previous = store.command(code, actor, input.id);
          if (previous) { if (previous.body !== serialized) fail(409, 'Action id was already used for a different request'); return JSON.parse(previous.response); }
          if (store.commandCount(code) >= maxCommands) fail(409, 'Room action limit reached; export this game');
          tick(room); act(room, actor, input);
          const response = { room, participantId: actor }; store.record(code, actor, input.id, serialized, response); cookie(res, code, credential(req, code)); return response;
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
    try { store.transaction(() => { store.prune(now()); for (const room of store.active()) tick(room); }); for (const [ip, rate] of rates) if (rate.until <= now()) rates.delete(ip); } catch (error) { console.error('Persistence maintenance failed:', error.message); }
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
