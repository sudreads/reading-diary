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

// Every limit below exists so that one stranger cannot fill the disk, the memory or a game.
const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // the app sends ~200 KB
const MAX_JSON_BYTES = 16 * 1024;
const MAX_PLAYERS = 60; // members + waiting, per game
const MAX_WAITING = 25;
const MAX_PLAYER_RECORDS = 300; // including everyone who left or was removed
const MAX_ENTRIES = 3000; // per game
const MAX_ENTRIES_PER_PLAYER = 400;
const MAX_STREAMS_PER_PLAYER = 4;
const MAX_STREAMS = 2000;
const MAX_CATEGORIES = 12;
const ENTRY_COOLDOWN_MS = 3000;
const GAME_TTL_MS = 30 * 24 * 3600 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_LENGTH = 6; // 32^6 = a billion codes; guesses are rate-limited as well

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
  const text = value.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ') // control + bidi overrides
    .replace(/[\u200b\u200c\u200e\u200f\u2060\ufeff\u00ad]/g, '') // invisible (the emoji joiner U+200D stays)
    .replace(/\s+/g, ' ').trim();
  // Cut by whole characters so an emoji is never sliced in half.
  return [...text].slice(0, max).join('').trim();
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

export function createApp({
  dataDir, now = () => Date.now(), createsPerHour = 20, joinsPerMinute = 30, joinsPerGameHour = 40, requestsPerMinute = 3000, playerRequestsPerMinute = 900, codeMisses = 15,
  trustProxy = 0, maxGames = 3000, maxTotalBytes = 5 * 1024 ** 3,
}) {
  const gamesDir = path.join(dataDir, 'games');
  const photosDir = path.join(dataDir, 'photos');
  fs.mkdirSync(gamesDir, { recursive: true });
  fs.mkdirSync(photosDir, { recursive: true });

  const games = new Map(); // code -> game
  const streams = new Map(); // code -> Set<{res, playerId}>
  const saving = new Map(); // code -> Promise chain
  const rate = new Map(); // key -> { count, resetAt }
  const uploading = new Set(); // player ids with an upload in flight
  let totalBytes = 0; // photos on disk, all games
  let streamCount = 0;

  for (const file of fs.readdirSync(gamesDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const game = JSON.parse(fs.readFileSync(path.join(gamesDir, file), 'utf8'));
      if (game && game.code) games.set(game.code, game);
    } catch { /* a half-written file from a crash: skip it, the rest still load */ }
  }
  for (const game of games.values()) for (const e of game.entries) totalBytes += e.size || 0;

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
      entries: game.entries.map((e) => ({ id: e.id, playerId: e.playerId, cat: e.cat, photo: `/api/games/${game.code}/photos/${e.file}`, ts: e.ts, note: e.note || '' })),
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
    for (const e of game.entries) totalBytes -= e.size || 0;
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

  // The token travels in the Authorization header only: never in a URL, so it never lands in
  // access logs, browser history or a Referer.
  function auth(game, req) {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || token.length > 200) throw new HttpError(401, 'no-token', 'צריך להצטרף למשחק קודם');
    const hash = sha(token);
    const me = game.players.find((p) => p.tokenHash === hash);
    if (!me) throw new HttpError(401, 'bad-token', 'צריך להצטרף למשחק קודם');
    return me;
  }

  const requireHost = (game, me) => { if (me.id !== game.hostId) throw new HttpError(403, 'host-only', 'רק הבוס יכול לעשות את זה'); };
  const requireIn = (me) => { if (me.status !== 'in') throw new HttpError(403, 'not-in', 'הבוס עוד לא הכניס אותך למשחק'); };

  // Two players never show the same name: nobody can pose as the boss or as a friend.
  function uniqueName(game, name) {
    const taken = new Set(game.players.filter((p) => p.status !== 'out').map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const candidate = `${[...name].slice(0, 16).join('').trim()} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

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
  // X-Forwarded-For is whatever the sender typed unless a proxy we run overwrote it. Only the
  // entry added by our own proxy (counted from the right) is believed, and only when configured.
  function ipOf(req) {
    if (trustProxy > 0) {
      const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
      const ip = hops[hops.length - trustProxy];
      if (ip) return ip.slice(0, 64);
    }
    return req.socket.remoteAddress || 'unknown';
  }

  // ----- routes -----

  async function createGame(req) {
    limit(`create:${ipOf(req)}`, createsPerHour, 3600_000);
    if (games.size >= maxGames) throw new HttpError(503, 'busy', 'יש יותר מדי משחקים כרגע, נסו מאוחר יותר');
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
    limit(`join:${game.code}:${ipOf(req)}`, joinsPerGameHour, 3600_000); // friends on one Wi-Fi share an address, so this is roomy; the waiting-list ceiling does the rest
    const body = await readJson(req);
    const playerName = cleanText(body.playerName, 20);
    if (!playerName) throw bad('no-name', 'איך קוראים לך?');
    if (game.status === 'ended') throw new HttpError(409, 'ended', 'המשחק הזה כבר נגמר');
    if (game.players.filter((p) => p.status !== 'out').length >= MAX_PLAYERS) throw new HttpError(409, 'full', 'המשחק מלא');
    if (game.players.filter((p) => p.status === 'waiting').length >= MAX_WAITING) throw new HttpError(409, 'full', 'רשימת ההמתנה מלאה, בקשו מהבוס להכניס אנשים');
    if (game.players.length >= MAX_PLAYER_RECORDS) throw new HttpError(409, 'full', 'המשחק מלא');
    const { player, token } = newPlayer(uniqueName(game, playerName), 'waiting');
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
    await changed(game); // their stream gets one last update saying "out"; later ones carry nothing private
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
    if (game.entries.filter((e) => e.playerId === me.id).length >= MAX_ENTRIES_PER_PLAYER) throw new HttpError(409, 'full', 'הגעת למקסימום התמונות במשחק הזה');
    if (totalBytes >= maxTotalBytes) throw new HttpError(507, 'disk-full', 'נגמר המקום בשרת, דברו עם מי שמפעיל אותו');
    const t = now();
    if (t - (me.lastEntryAt || 0) < ENTRY_COOLDOWN_MS) throw new HttpError(429, 'slow-down', 'רגע, לאט לאט. נסו שוב עוד כמה שניות');
    // One upload at a time per player: parallel requests cannot slip past the cooldown.
    if (uploading.has(me.id)) throw new HttpError(429, 'slow-down', 'תמונה אחת בכל פעם');
    uploading.add(me.id);
    try {
      // The photo is the proof: no image, no point.
      const buf = await readBody(req, MAX_PHOTO_BYTES);
      const ext = sniffImage(buf);
      if (!ext) throw bad('no-photo', 'בלי תמונה זה לא נחשב');
      const note = cleanText(url.searchParams.get('note') || '', 80);
      const dir = path.join(photosDir, game.code);
      await fsp.mkdir(dir, { recursive: true });
      const file = `${newId(16)}.${ext}`;
      await fsp.writeFile(path.join(dir, file), buf, { mode: 0o600 });
      // The world may have moved while the upload was in flight.
      if (game.status !== 'active' || me.status !== 'in' || !games.has(game.code)) {
        await fsp.rm(path.join(dir, file), { force: true });
        throw new HttpError(409, 'not-active', 'המשחק נגמר');
      }
      me.lastEntryAt = t;
      totalBytes += buf.length;
      const entry = { id: newId(8), playerId: me.id, cat, file, ts: t, note, size: buf.length };
      game.entries.push(entry);
      await changed(game);
      return { ok: true, id: entry.id };
    } finally { uploading.delete(me.id); }
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
    totalBytes -= entry.size || 0;
    await fsp.rm(path.join(photosDir, game.code, entry.file), { force: true });
    await changed(game);
    return { ok: true };
  }

  function events(game, me, req, res) {
    if (streamCount >= MAX_STREAMS) throw new HttpError(503, 'busy', 'השרת עמוס, נסו שוב עוד רגע');
    // A player with many tabs keeps the newest ones; the oldest stream is closed.
    const mine = [...(streams.get(game.code) || [])].filter((c) => c.playerId === me.id);
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_STREAMS_PER_PLAYER + 1))) old.res.end();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\ndata: ${JSON.stringify(view(game, me))}\n\n`);
    const client = { res, playerId: me.id };
    if (!streams.has(game.code)) streams.set(game.code, new Set());
    streams.get(game.code).add(client);
    streamCount++;
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => {
      clearInterval(ping);
      streamCount--;
      const set = streams.get(game.code);
      if (set) { set.delete(client); if (!set.size) streams.delete(game.code); }
    });
  }

  // Photos are for members only: the request carries the player's token like every other call,
  // and the file must be one of this game's entries. A copied link opens nothing.
  async function servePhoto(game, me, res, file) {
    requireIn(me);
    if (!game.entries.some((e) => e.file === file)) throw new HttpError(404, 'not-found');
    const full = path.join(photosDir, game.code, file);
    let stat;
    try { stat = await fsp.stat(full); } catch { throw new HttpError(404, 'not-found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)], 'Content-Length': stat.size,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Disposition': 'inline', 'X-Robots-Tag': 'noindex',
    });
    const stream = fs.createReadStream(full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    // Only plain file names that ship with the app: no dot-files, no folders, nothing encoded.
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]+$/i.test(rel) || rel.includes('..')) throw new HttpError(404, 'not-found');
    const full = path.join(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'not-found');
    let body;
    try { body = await fsp.readFile(full); } catch { throw new HttpError(404, 'not-found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Content-Length': body.length,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'geolocation=(), microphone=(), payment=(), usb=()',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'X-Robots-Tag': 'noindex',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  }

  function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  }

  async function route(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { throw bad('bad-url', 'בקשה לא תקינה'); }
    const parts = url.pathname.split('/').filter(Boolean);
    const m = req.method;
    const ip = ipOf(req);
    // A whole party often sits behind one Wi-Fi address, so the per-address ceiling is high and
    // the tight limit is per player, once we know who is asking.
    limit(`all:${ip}`, requestsPerMinute, 60_000);

    if (parts[0] === 'api') {
      // Same-origin only: a page on another site cannot drive the API with a player's browser.
      const origin = req.headers.origin;
      if (origin && m !== 'GET' && !sameHost(origin, req.headers.host)) throw new HttpError(403, 'cross-origin');
      if (m !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-origin');
      if (parts[1] === 'health' && m === 'GET') return sendJson(res, 200, { ok: true });
      if (parts[1] === 'defaults' && m === 'GET') return sendJson(res, 200, { categories: DEFAULT_CATEGORIES });
      if (parts[1] !== 'games') throw new HttpError(404, 'not-found');
      if (parts.length === 2 && m === 'POST') return sendJson(res, 201, await createGame(req));
      // Guessing codes: after a handful of misses this address gets no more answers for a while.
      const misses = rate.get(`miss:${ip}`);
      if (misses && misses.resetAt > now() && misses.count >= codeMisses) throw new HttpError(429, 'slow-down', 'יותר מדי ניסיונות, נסו שוב מאוחר יותר');
      let game;
      try { game = getGame(parts[2]); }
      catch (e) { try { limit(`miss:${ip}`, Infinity, 600_000); } catch { /* counting only */ } throw e; }
      const action = parts[3];
      if (action === 'join' && m === 'POST') return sendJson(res, 201, await joinGame(game, req));
      const me = auth(game, req);
      limit(`player:${me.id}`, playerRequestsPerMinute, 60_000);
      if (!action && m === 'GET') return sendJson(res, 200, view(game, me));
      if (action === 'events' && m === 'GET') return events(game, me, req, res);
      if (action === 'approve' && m === 'POST') return sendJson(res, 200, await approve(game, me, req));
      if (action === 'kick' && m === 'POST') return sendJson(res, 200, await kick(game, me, req));
      if (action === 'leave' && m === 'POST') return sendJson(res, 200, await leave(game, me));
      if (action === 'start' && m === 'POST') return sendJson(res, 200, await start(game, me, req));
      if (action === 'end' && m === 'POST') return sendJson(res, 200, await end(game, me));
      if (action === 'photos' && parts.length === 5 && m === 'GET') return servePhoto(game, me, res, parts[4]);
      if (action === 'entries' && parts.length === 4 && m === 'POST') return sendJson(res, 201, await addEntry(game, me, req, url));
      if (action === 'entries' && parts.length === 5 && m === 'DELETE') return sendJson(res, 200, await removeEntry(game, me, parts[4]));
      throw new HttpError(404, 'not-found');
    }
    if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'method');
    return serveStatic(res, url.pathname);
  }

  const server = http.createServer((req, res) => {
    // A socket that dies mid-request must never take the process down with it.
    req.on('error', () => {});
    res.on('error', () => {});
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) { res.end(); return; }
      // The rest of a refused upload is not worth reading: close the connection after answering.
      if (!req.complete) res.setHeader('Connection', 'close');
      if (status === 429) res.setHeader('Retry-After', '10');
      sendJson(res, status, { error: e.code || 'server', message: status === 500 ? 'משהו השתבש' : e.message });
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 10_000;
  server.maxHeadersCount = 60;
  server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); });
  const timer = setInterval(sweep, 15_000);
  timer.unref();
  server.on('close', () => clearInterval(timer));

  return { server, games, sweep, flush: () => Promise.all([...saving.values()]), stats: () => ({ games: games.size, totalBytes, streams: streamCount }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const dataDir = process.env.DATA_DIR || path.join(HERE, 'data');
  const trustProxy = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY || 0)) || 0);
  const maxTotalBytes = (Number(process.env.MAX_STORAGE_MB) || 5120) * 1024 * 1024;
  const { server, flush } = createApp({ dataDir, trustProxy, maxTotalBytes });
  server.listen(port, () => {
    console.log(`Food Wars on http://localhost:${port}  (data: ${dataDir})`);
    if (!trustProxy) console.log('TRUST_PROXY is not set: behind a reverse proxy every visitor counts as one address for rate limits.');
  });
  // One bad request must not end everyone's game: log it and keep serving.
  process.on('uncaughtException', (e) => console.error('uncaught', e));
  process.on('unhandledRejection', (e) => console.error('unhandled', e));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { server.closeAllConnections(); server.close(() => flush().finally(() => process.exit(0))); });
  }
}
