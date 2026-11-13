// Food Wars / Beer Wars - game server.
// Zero dependencies on purpose: `node server.js` is the whole deployment.
// State lives in DATA_DIR as one JSON file per game plus the uploaded photos.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_PLAYERS = 60;
const MAX_ENTRIES = 5000;
const MAX_CATEGORIES = 12;
const ENTRY_COOLDOWN_MS = 3000;
const GAME_TTL_MS = 30 * 24 * 3600 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_LENGTH = 5;

export const DEFAULT_CATEGORIES = [
  { id: 'beer', emoji: '🍺', label: 'לשתות בירה' },
  { id: 'water', emoji: '💧', label: 'לשתות מים' },
  { id: 'food', emoji: '🍔', label: 'לאכול' },
  { id: 'beach', emoji: '🏖️', label: 'להיות בים' },
  { id: 'party', emoji: '🎉', label: 'להיות במסיבה' },
  { id: 'view', emoji: '📸', label: 'לצלם נוף' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (code, message) => new HttpError(400, code, message);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

// Trim, collapse whitespace, drop control and bidi-override characters, cap the length.
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Which image format the bytes really are; the Content-Type header is not trusted.
export function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function parseCategories(input) {
  if (input === undefined) return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_CATEGORIES) throw bad('bad-categories', 'צריך לבחור בין קטגוריה אחת ל-12');
  const seen = new Set();
  return input.map((raw, i) => {
    const label = cleanText(raw && raw.label, 30);
    const emoji = cleanText(raw && raw.emoji, 8) || '⭐';
    if (!label) throw bad('bad-categories', 'לכל קטגוריה צריך שם');
    let id = cleanText(raw && raw.id, 20).replace(/[^a-z0-9_-]/gi, '').toLowerCase() || `c${i}`;
    while (seen.has(id)) id += 'x';
    seen.add(id);
    return { id, emoji, label };
  });
}

export function createApp({ dataDir, now = () => Date.now(), createsPerHour = 20, joinsPerMinute = 30 }) {
  const gamesDir = path.join(dataDir, 'games');
  const photosDir = path.join(dataDir, 'photos');
  fs.mkdirSync(gamesDir, { recursive: true });
  fs.mkdirSync(photosDir, { recursive: true });

  const games = new Map(); // code -> game
  const streams = new Map(); // code -> Set<{res, playerId}>
  const saving = new Map(); // code -> Promise chain
  const rate = new Map(); // key -> { count, resetAt }

  for (const file of fs.readdirSync(gamesDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const game = JSON.parse(fs.readFileSync(path.join(gamesDir, file), 'utf8'));
      if (game && game.code) games.set(game.code, game);
    } catch { /* a half-written file from a crash: skip it, the rest still load */ }
  }

  function save(game) {
    const file = path.join(gamesDir, `${game.code}.json`);
    const next = (saving.get(game.code) || Promise.resolve()).then(async () => {
      if (!games.has(game.code)) return;
      const tmp = `${file}.${newId(4)}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(game));
      await fsp.rename(tmp, file);
    }).catch((e) => console.error('save failed', game.code, e.message));
    saving.set(game.code, next);
    return next;
  }

  function limit(key, max, windowMs) {
    const t = now();
    let slot = rate.get(key);
    if (!slot || slot.resetAt <= t) { slot = { count: 0, resetAt: t + windowMs }; rate.set(key, slot); }
    slot.count++;
    if (slot.count > max) throw new HttpError(429, 'slow-down', 'יותר מדי בקשות, נסו שוב עוד רגע');
  }

  function newCode() {
    for (let tries = 0; tries < 50; tries++) {
      let code = '';
      for (const b of crypto.randomBytes(CODE_LENGTH)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (!games.has(code)) return code;
    }
    throw new HttpError(503, 'busy', 'נסו שוב');
  }

  // What one player is allowed to see. Players still waiting see the lobby only, not the photos.
  function view(game, me) {
    const base = {
      code: game.code, name: game.name, status: game.status, categories: game.categories,
      createdAt: game.createdAt, startedAt: game.startedAt, endedAt: game.endedAt, endsAt: game.endsAt,
      hostId: game.hostId, me: { id: me.id, name: me.name, status: me.status, isHost: me.id === game.hostId },
      serverTime: now(),
    };
    const pub = (p) => ({ id: p.id, name: p.name, status: p.status, joinedAt: p.joinedAt });
    if (me.status !== 'in') {
      const host = game.players.find((p) => p.id === game.hostId);
      return { ...base, hostName: host ? host.name : '', players: [], entries: [], memberCount: game.players.filter((p) => p.status === 'in').length };
    }
    const visible = game.players.filter((p) => p.status === 'in' || (p.status === 'waiting' && me.id === game.hostId)
      || (p.status === 'out' && game.entries.some((e) => e.playerId === p.id)));
    return {
      ...base, players: visible.map(pub),
      waitingCount: game.players.filter((p) => p.status === 'waiting').length,
      entries: game.entries.map((e) => ({ id: e.id, playerId: e.playerId, cat: e.cat, photo: `/photos/${game.code}/${e.file}`, ts: e.ts, note: e.note || '' })),
    };
  }

  function broadcast(game) {
    const set = streams.get(game.code);
    if (!set) return;
    for (const client of set) {
      const me = game.players.find((p) => p.id === client.playerId);
      if (!me) { client.res.end(); set.delete(client); continue; }
      client.res.write(`data: ${JSON.stringify(view(game, me))}\n\n`);
    }
  }

  function changed(game) { broadcast(game); return save(game); }

  function endIfDue(game) {
    if (game.status === 'active' && game.endsAt && game.endsAt <= now()) {
      game.status = 'ended';
      game.endedAt = game.endsAt;
      return true;
    }
    return false;
  }

  function sweep() {
    const t = now();
    for (const game of [...games.values()]) {
      if (endIfDue(game)) changed(game);
      if (t - (game.endedAt || game.createdAt) > GAME_TTL_MS) removeGame(game);
    }
    for (const [key, slot] of rate) if (slot.resetAt <= t) rate.delete(key);
  }

  function removeGame(game) {
    games.delete(game.code);
    for (const client of streams.get(game.code) || []) client.res.end();
    streams.delete(game.code);
    fsp.rm(path.join(gamesDir, `${game.code}.json`), { force: true }).catch(() => {});
    fsp.rm(path.join(photosDir, game.code), { recursive: true, force: true }).catch(() => {});
  }

  function getGame(code) {
    const game = games.get(String(code || '').toUpperCase());
    if (!game) throw new HttpError(404, 'no-game', 'לא מצאנו משחק עם הקוד הזה');
    if (endIfDue(game)) changed(game);
    return game;
  }

  function auth(game, req, url) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token') || '';
    if (!token) throw new HttpError(401, 'no-token', 'צריך להצטרף למשחק קודם');
    const hash = sha(token);
    const me = game.players.find((p) => p.tokenHash === hash);
    if (!me) throw new HttpError(401, 'bad-token', 'צריך להצטרף למשחק קודם');
    return me;
  }

  const requireHost = (game, me) => { if (me.id !== game.hostId) throw new HttpError(403, 'host-only', 'רק הבוס יכול לעשות את זה'); };
  const requireIn = (me) => { if (me.status !== 'in') throw new HttpError(403, 'not-in', 'הבוס עוד לא הכניס אותך למשחק'); };

  function newPlayer(name, status) {
    const token = newId(24);
    return { player: { id: newId(6), name, status, joinedAt: now(), tokenHash: sha(token), lastEntryAt: 0 }, token };
  }

  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > max) { reject(new HttpError(413, 'too-big', 'הקובץ גדול מדי')); req.resume(); return; }
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > max) { reject(new HttpError(413, 'too-big', 'הקובץ גדול מדי')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function readJson(req) {
    const buf = await readBody(req, MAX_JSON_BYTES);
    if (!buf.length) return {};
    try {
      const value = JSON.parse(buf.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value;
    } catch { throw bad('bad-json', 'בקשה לא תקינה'); }
  }

  const sameHost = (origin, host) => { try { return new URL(origin).host === host; } catch { return false; } };
  const ipOf = (req) => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  // ----- routes -----

  async function createGame(req) {
    limit(`create:${ipOf(req)}`, createsPerHour, 3600_000);
    const body = await readJson(req);
    const playerName = cleanText(body.playerName, 20);
    if (!playerName) throw bad('no-name', 'איך קוראים לך?');
    const name = cleanText(body.name, 40) || `המשחק של ${playerName}`;
    const categories = parseCategories(body.categories);
    const { player, token } = newPlayer(playerName, 'in');
    const game = {
      code: newCode(), name, status: 'lobby', categories, hostId: player.id,
      createdAt: now(), startedAt: null, endedAt: null, endsAt: null,
      players: [player], entries: [],
    };
    games.set(game.code, game);
    await save(game);
    return { code: game.code, token, playerId: player.id };
  }

  async function joinGame(game, req) {
    limit(`join:${ipOf(req)}`, joinsPerMinute, 60_000);
    const body = await readJson(req);
    const playerName = cleanText(body.playerName, 20);
    if (!playerName) throw bad('no-name', 'איך קוראים לך?');
    if (game.status === 'ended') throw new HttpError(409, 'ended', 'המשחק הזה כבר נגמר');
    if (game.players.filter((p) => p.status !== 'out').length >= MAX_PLAYERS) throw new HttpError(409, 'full', 'המשחק מלא');
    const { player, token } = newPlayer(playerName, 'waiting');
    game.players.push(player);
    await changed(game);
    return { code: game.code, token, playerId: player.id };
  }

  async function approve(game, me, req) {
    requireHost(game, me);
    const body = await readJson(req);
    const targets = game.players.filter((p) => p.status === 'waiting' && (body.all === true || p.id === body.playerId));
    if (!targets.length) throw new HttpError(404, 'no-player', 'אין מי שמחכה');
    for (const p of targets) p.status = 'in';
    await changed(game);
    return { ok: true };
  }

  async function kick(game, me, req) {
    requireHost(game, me);
    const body = await readJson(req);
    const target = game.players.find((p) => p.id === body.playerId);
    if (!target || target.status === 'out') throw new HttpError(404, 'no-player', 'השחקן לא נמצא');
    if (target.id === game.hostId) throw bad('host-stays', 'הבוס לא יכול להעיף את עצמו');
    target.status = 'out';
    await changed(game);
    return { ok: true };
  }

  async function leave(game, me) {
    if (me.id === game.hostId) throw bad('host-stays', 'הבוס לא יכול לעזוב. אפשר לסיים את המשחק');
    me.status = 'out';
    await changed(game);
    return { ok: true };
  }

  async function start(game, me, req) {
    requireHost(game, me);
    if (game.status !== 'lobby') throw new HttpError(409, 'not-lobby', 'המשחק כבר התחיל');
    const body = await readJson(req);
    if (body.categories !== undefined) game.categories = parseCategories(body.categories);
    const hours = Number(body.hours);
    game.status = 'active';
    game.startedAt = now();
    game.endsAt = Number.isFinite(hours) && hours > 0 ? game.startedAt + Math.min(hours, 24 * 14) * 3600_000 : null;
    await changed(game);
    return { ok: true };
  }

  async function end(game, me) {
    requireHost(game, me);
    if (game.status !== 'active') throw new HttpError(409, 'not-active', 'המשחק לא פעיל');
    game.status = 'ended';
    game.endedAt = now();
    await changed(game);
    return { ok: true };
  }

  async function addEntry(game, me, req, url) {
    requireIn(me);
    if (game.status !== 'active') throw new HttpError(409, 'not-active', game.status === 'lobby' ? 'המשחק עוד לא התחיל' : 'המשחק נגמר');
    const cat = url.searchParams.get('cat');
    if (!game.categories.some((c) => c.id === cat)) throw bad('bad-category', 'קטגוריה לא מוכרת');
    if (game.entries.length >= MAX_ENTRIES) throw new HttpError(409, 'full', 'הגלריה מלאה');
    const t = now();
    if (t - (me.lastEntryAt || 0) < ENTRY_COOLDOWN_MS) throw new HttpError(429, 'slow-down', 'רגע, לאט לאט. נסו שוב עוד כמה שניות');
    // The photo is the proof: no image, no point.
    const buf = await readBody(req, MAX_PHOTO_BYTES);
    const ext = sniffImage(buf);
    if (!ext) throw bad('no-photo', 'בלי תמונה זה לא נחשב');
    const note = cleanText(url.searchParams.get('note') || '', 80);
    const dir = path.join(photosDir, game.code);
    await fsp.mkdir(dir, { recursive: true });
    const file = `${newId(16)}.${ext}`;
    await fsp.writeFile(path.join(dir, file), buf);
    if (game.status !== 'active') { // ended while the upload was in flight
      await fsp.rm(path.join(dir, file), { force: true });
      throw new HttpError(409, 'not-active', 'המשחק נגמר');
    }
    me.lastEntryAt = t;
    const entry = { id: newId(8), playerId: me.id, cat, file, ts: t, note };
    game.entries.push(entry);
    await changed(game);
    return { ok: true, id: entry.id };
  }

  async function removeEntry(game, me, entryId) {
    requireIn(me);
    const i = game.entries.findIndex((e) => e.id === entryId);
    if (i < 0) throw new HttpError(404, 'no-entry', 'התמונה לא נמצאה');
    const entry = game.entries[i];
    const isHost = me.id === game.hostId;
    if (entry.playerId !== me.id && !isHost) throw new HttpError(403, 'not-yours', 'אפשר למחוק רק תמונות שלך');
    if (game.status === 'ended' && !isHost) throw new HttpError(409, 'ended', 'המשחק נגמר');
    game.entries.splice(i, 1);
    await fsp.rm(path.join(photosDir, game.code, entry.file), { force: true });
    await changed(game);
    return { ok: true };
  }

  function events(game, me, req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\ndata: ${JSON.stringify(view(game, me))}\n\n`);
    const client = { res, playerId: me.id };
    if (!streams.has(game.code)) streams.set(game.code, new Set());
    streams.get(game.code).add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); streams.get(game.code)?.delete(client); });
  }

  async function servePhoto(res, code, file) {
    if (!/^[A-Z0-9]+$/.test(code) || !/^[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(file)) throw new HttpError(404, 'not-found');
    const full = path.join(photosDir, code, file);
    let stat;
    try { stat = await fsp.stat(full); } catch { throw new HttpError(404, 'not-found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)], 'Content-Length': stat.size,
      'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer',
    });
    fs.createReadStream(full).pipe(res);
  }

  async function serveStatic(res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    let full = path.join(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'not-found');
    let body;
    try { body = await fsp.readFile(full); } catch { throw new HttpError(404, 'not-found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Content-Length': body.length,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  }

  function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const m = req.method;

    if (parts[0] === 'api') {
      // Same-origin only: a page on another site cannot drive the API with a player's browser.
      const origin = req.headers.origin;
      if (origin && m !== 'GET' && !sameHost(origin, req.headers.host)) throw new HttpError(403, 'cross-origin');
      if (parts[1] === 'health' && m === 'GET') return sendJson(res, 200, { ok: true, games: games.size });
      if (parts[1] === 'defaults' && m === 'GET') return sendJson(res, 200, { categories: DEFAULT_CATEGORIES });
      if (parts[1] !== 'games') throw new HttpError(404, 'not-found');
      if (parts.length === 2 && m === 'POST') return sendJson(res, 201, await createGame(req));
      const game = getGame(parts[2]);
      const action = parts[3];
      if (action === 'join' && m === 'POST') return sendJson(res, 201, await joinGame(game, req));
      const me = auth(game, req, url);
      if (!action && m === 'GET') return sendJson(res, 200, view(game, me));
      if (action === 'events' && m === 'GET') return events(game, me, req, res);
      if (action === 'approve' && m === 'POST') return sendJson(res, 200, await approve(game, me, req));
      if (action === 'kick' && m === 'POST') return sendJson(res, 200, await kick(game, me, req));
      if (action === 'leave' && m === 'POST') return sendJson(res, 200, await leave(game, me));
      if (action === 'start' && m === 'POST') return sendJson(res, 200, await start(game, me, req));
      if (action === 'end' && m === 'POST') return sendJson(res, 200, await end(game, me));
      if (action === 'entries' && parts.length === 4 && m === 'POST') return sendJson(res, 201, await addEntry(game, me, req, url));
      if (action === 'entries' && parts.length === 5 && m === 'DELETE') return sendJson(res, 200, await removeEntry(game, me, parts[4]));
      throw new HttpError(404, 'not-found');
    }
    if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'method');
    if (parts[0] === 'photos' && parts.length === 3) return servePhoto(res, parts[1], parts[2]);
    return serveStatic(res, url.pathname);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) { res.end(); return; }
      sendJson(res, status, { error: e.code || 'server', message: status === 500 ? 'משהו השתבש' : e.message });
    });
  });
  server.requestTimeout = 60_000;
  const timer = setInterval(sweep, 15_000);
  timer.unref();
  server.on('close', () => clearInterval(timer));

  return { server, games, sweep, flush: () => Promise.all([...saving.values()]) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const dataDir = process.env.DATA_DIR || path.join(HERE, 'data');
  const { server } = createApp({ dataDir });
  server.listen(port, () => console.log(`Food Wars on http://localhost:${port}  (data: ${dataDir})`));
}
