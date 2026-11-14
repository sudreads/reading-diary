// API tests: a real server on a random port, a throwaway data directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, sniffImage, cleanText } from '../server.js';
import { scores, ranking, categoryWinners } from '../public/score.js';

// Smallest valid-looking images: only the magic bytes matter to the server.
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

let dataDir, app, base, clock;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-test-'));
  clock = Date.now();
  app = createApp({ dataDir, now: () => clock, createsPerHour: 1000, joinsPerMinute: 1000, joinsPerGameHour: 1000, codeMisses: 1000, requestsPerMinute: 100000 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
  await app.flush();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, { token, json, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let body;
  if (json) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  if (raw) { body = raw; h['Content-Type'] = 'image/jpeg'; }
  const res = await fetch(base + url, { method, headers: h, body });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.arrayBuffer() };
}

async function newGame(extra = {}) {
  const res = await call('POST', '/api/games', { json: { playerName: 'בוס', name: 'ערב שישי', ...extra } });
  assert.equal(res.status, 201);
  return res.body;
}
async function joinAs(code, playerName) {
  const res = await call('POST', `/api/games/${code}/join`, { json: { playerName } });
  assert.equal(res.status, 201);
  return res.body;
}
const state = async (code, token) => (await call('GET', `/api/games/${code}`, { token })).body;
const tick = (ms = 4000) => { clock += ms; };
async function point(code, token, cat = 'beer', photo = JPEG) {
  tick();
  return call('POST', `/api/games/${code}/entries?cat=${cat}`, { token, raw: photo });
}

test('helpers: sniffImage and cleanText', () => {
  assert.equal(sniffImage(JPEG), 'jpg');
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  assert.equal(cleanText('  דני \n\t  כהן  ', 20), 'דני כהן');
  assert.equal(cleanText('a‮b', 20), 'a b');
  assert.equal(cleanText(42, 20), '');
  assert.equal(cleanText('x'.repeat(50), 20).length, 20);
});

test('create a game: host is in, default categories, 6-letter code', async () => {
  const g = await newGame();
  assert.match(g.code, /^[A-HJ-NP-Z2-9]{6}$/);
  const s = await state(g.code, g.token);
  assert.equal(s.status, 'lobby');
  assert.equal(s.name, 'ערב שישי');
  assert.equal(s.me.isHost, true);
  assert.equal(s.me.status, 'in');
  assert.deepEqual(s.categories.map((c) => c.id), ['beer', 'water', 'food', 'beach', 'party', 'view']);
  assert.equal(JSON.stringify(s).includes('tokenHash'), false);
});

test('create needs a name; bad categories are refused', async () => {
  assert.equal((await call('POST', '/api/games', { json: { playerName: '   ' } })).status, 400);
  assert.equal((await call('POST', '/api/games', { json: { playerName: 'a', categories: [] } })).status, 400);
  assert.equal((await call('POST', '/api/games', { json: { playerName: 'a', categories: [{ emoji: '🍕' }] } })).status, 400);
  assert.equal((await call('POST', '/api/games', { headers: { 'Content-Type': 'application/json' }, raw: Buffer.from('{nope') })).status, 400);
});

test('custom categories get safe unique ids', async () => {
  const g = await newGame({ categories: [{ id: 'A b<>', emoji: '🍕', label: 'פיצה' }, { id: 'ab', emoji: '', label: 'שווארמה' }] });
  const s = await state(g.code, g.token);
  assert.deepEqual(s.categories, [{ id: 'ab', emoji: '🍕', label: 'פיצה' }, { id: 'abx', emoji: '⭐', label: 'שווארמה' }]);
});

test('joining puts you on the waiting list; only the boss lets you in', async () => {
  const g = await newGame();
  const dana = await joinAs(g.code.toLowerCase(), 'דנה'); // codes are case-insensitive
  const yossi = await joinAs(g.code, 'יוסי');

  let s = await state(g.code, dana.token);
  assert.equal(s.me.status, 'waiting');
  assert.equal(s.hostName, 'בוס');
  assert.deepEqual(s.players, []); // waiting players see nobody
  assert.deepEqual(s.entries, []);

  const host = await state(g.code, g.token);
  assert.equal(host.waitingCount, 2);
  assert.deepEqual(host.players.filter((p) => p.status === 'waiting').map((p) => p.name), ['דנה', 'יוסי']);

  assert.equal((await call('POST', `/api/games/${g.code}/approve`, { token: dana.token, json: { all: true } })).status, 403);
  assert.equal((await call('POST', `/api/games/${g.code}/start`, { token: dana.token, json: {} })).status, 403);

  assert.equal((await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { playerId: dana.playerId } })).status, 200);
  s = await state(g.code, dana.token);
  assert.equal(s.me.status, 'in');
  assert.deepEqual(s.players.map((p) => p.name), ['בוס', 'דנה']); // members do not see the waiting list
  assert.equal((await state(g.code, yossi.token)).me.status, 'waiting');

  assert.equal((await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { all: true } })).status, 200);
  assert.equal((await state(g.code, yossi.token)).me.status, 'in');
  assert.equal((await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { all: true } })).status, 404);
});

test('auth: no token, wrong token, token from another game', async () => {
  const a = await newGame(), b = await newGame();
  assert.equal((await call('GET', `/api/games/${a.code}`)).status, 401);
  assert.equal((await call('GET', `/api/games/${a.code}`, { token: 'nope' })).status, 401);
  assert.equal((await call('GET', `/api/games/${a.code}`, { token: b.token })).status, 401);
  assert.equal((await call('GET', '/api/games/ZZZZZZ', { token: a.token })).status, 404);
});

test('points need a real photo, an active game and a member', async () => {
  const g = await newGame();
  const dana = await joinAs(g.code, 'דנה');
  assert.equal((await point(g.code, g.token)).status, 409); // lobby
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  assert.equal((await point(g.code, dana.token)).status, 403); // still waiting
  await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { all: true } });

  tick();
  assert.equal((await call('POST', `/api/games/${g.code}/entries?cat=beer`, { token: dana.token })).status, 400); // no photo
  assert.equal((await point(g.code, dana.token, 'beer', Buffer.from('<html><script>alert(1)</script>'))).status, 400);
  assert.equal((await point(g.code, dana.token, 'vodka')).status, 400);
  assert.equal((await point(g.code, dana.token, 'beer', Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]))).status, 413);

  const ok = await point(g.code, dana.token, 'beer', PNG);
  assert.equal(ok.status, 201);
  // No cooldown bypass: a second point right away is refused.
  assert.equal((await call('POST', `/api/games/${g.code}/entries?cat=beer`, { token: dana.token, raw: JPEG })).status, 429);
  assert.equal((await point(g.code, dana.token, 'food')).status, 201);

  const s = await state(g.code, g.token);
  assert.equal(s.entries.length, 2);
  assert.match(s.entries[0].photo, new RegExp(`^/api/games/${g.code}/photos/[\\w-]+\\.png$`));
  const photo = await call('GET', s.entries[0].photo, { token: dana.token });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.equal(photo.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(photo.body).equals(PNG), true);
});

test('deleting: own photos while active, the boss any time, nobody else', async () => {
  const g = await newGame();
  const dana = await joinAs(g.code, 'דנה'), yossi = await joinAs(g.code, 'יוסי');
  await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { all: true } });
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  const a = (await point(g.code, dana.token)).body.id;
  const b = (await point(g.code, dana.token)).body.id;
  const c = (await point(g.code, yossi.token)).body.id;
  const file = (await state(g.code, g.token)).entries[0].photo;

  assert.equal((await call('DELETE', `/api/games/${g.code}/entries/${a}`, { token: yossi.token })).status, 403);
  assert.equal((await call('DELETE', `/api/games/${g.code}/entries/${a}`, { token: dana.token })).status, 200);
  assert.equal((await call('GET', file, { token: g.token })).status, 404); // the file goes too
  assert.equal((await call('DELETE', `/api/games/${g.code}/entries/${a}`, { token: dana.token })).status, 404);

  await call('POST', `/api/games/${g.code}/end`, { token: g.token });
  assert.equal((await call('DELETE', `/api/games/${g.code}/entries/${b}`, { token: dana.token })).status, 409);
  assert.equal((await call('DELETE', `/api/games/${g.code}/entries/${c}`, { token: g.token })).status, 200);
  assert.deepEqual((await state(g.code, g.token)).entries.map((e) => e.id), [b]);
});

test('end of game: no more points, no more joining, results stay', async () => {
  const g = await newGame();
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  assert.equal((await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} })).status, 409);
  await point(g.code, g.token);
  assert.equal((await call('POST', `/api/games/${g.code}/end`, { token: g.token })).status, 200);
  assert.equal((await call('POST', `/api/games/${g.code}/end`, { token: g.token })).status, 409);
  assert.equal((await point(g.code, g.token)).status, 409);
  assert.equal((await call('POST', `/api/games/${g.code}/join`, { json: { playerName: 'מאחר' } })).status, 409);
  const s = await state(g.code, g.token);
  assert.equal(s.status, 'ended');
  assert.equal(s.entries.length, 1);
});

test('a timed game ends by itself', async () => {
  const g = await newGame();
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: { hours: 1 } });
  let s = await state(g.code, g.token);
  assert.equal(s.endsAt - s.startedAt, 3600_000);
  tick(3599_000);
  assert.equal((await state(g.code, g.token)).status, 'active');
  tick(2000);
  s = await state(g.code, g.token);
  assert.equal(s.status, 'ended');
  assert.equal(s.endedAt, s.endsAt);
});

test('kick and leave: out of the game, photos stay, the boss cannot go', async () => {
  const g = await newGame();
  const dana = await joinAs(g.code, 'דנה'), yossi = await joinAs(g.code, 'יוסי');
  await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { all: true } });
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  await point(g.code, dana.token);
  assert.equal((await call('POST', `/api/games/${g.code}/kick`, { token: dana.token, json: { playerId: yossi.playerId } })).status, 403);
  assert.equal((await call('POST', `/api/games/${g.code}/kick`, { token: g.token, json: { playerId: g.playerId } })).status, 400);
  assert.equal((await call('POST', `/api/games/${g.code}/leave`, { token: g.token })).status, 400);
  assert.equal((await call('POST', `/api/games/${g.code}/kick`, { token: g.token, json: { playerId: dana.playerId } })).status, 200);
  assert.equal((await call('POST', `/api/games/${g.code}/leave`, { token: yossi.token })).status, 200);
  assert.equal((await point(g.code, dana.token)).status, 403);
  assert.equal((await state(g.code, dana.token)).me.status, 'out');
  const s = await state(g.code, g.token);
  assert.deepEqual(s.players.map((p) => [p.name, p.status]), [['בוס', 'in'], ['דנה', 'out']]); // דנה has a photo, יוסי has none
  assert.equal(s.entries.length, 1);
});

test('live updates arrive over the event stream', async () => {
  const g = await newGame();
  // The token is accepted in the header only: a URL would leak it into logs and history.
  assert.equal((await fetch(`${base}/api/games/${g.code}/events?token=${g.token}`)).status, 401);
  const res = await fetch(`${base}/api/games/${g.code}/events`, { headers: { Authorization: `Bearer ${g.token}` } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const next = async () => {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buf += decoder.decode(value, { stream: true });
    }
  };
  assert.equal((await next()).waitingCount, 0);
  await joinAs(g.code, 'דנה');
  assert.equal((await next()).waitingCount, 1);
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  assert.equal((await next()).status, 'active');
  await reader.cancel();
});

test('games survive a restart', async () => {
  const g = await newGame();
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  await point(g.code, g.token, 'water');
  await app.flush();
  const again = createApp({ dataDir, now: () => clock });
  const saved = again.games.get(g.code);
  assert.equal(saved.status, 'active');
  assert.equal(saved.entries.length, 1);
  again.server.close();
});

test('rate limits: creating games and guessing codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-rate-'));
  const small = createApp({ dataDir: dir, createsPerHour: 2, joinsPerMinute: 3 });
  await new Promise((r) => small.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${small.server.address().port}`;
  const post = (p, json) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) }).then((r) => r.status);
  assert.deepEqual([await post('/api/games', { playerName: 'a' }), await post('/api/games', { playerName: 'a' }), await post('/api/games', { playerName: 'a' })], [201, 201, 429]);
  const code = [...small.games.keys()][0];
  const tries = [];
  for (let i = 0; i < 4; i++) tries.push(await post(`/api/games/${code}/join`, { playerName: 'b' }));
  assert.deepEqual(tries, [201, 201, 201, 429]);
  await new Promise((r) => small.server.close(r));
  await small.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('static files, path traversal, cross-origin posts', async () => {
  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  const csp = home.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self';/); // no inline scripts, no eval, no other origins
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(csp.includes('unsafe'), false);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('GET', '/.env')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/server.js')).status, 404);
  assert.equal((await call('GET', '//etc/passwd')).status, 404);
  assert.equal((await call('GET', '/app.js%00.png')).status, 404);
  assert.equal((await call('PUT', '/app.js', { raw: JPEG })).status, 405);
  assert.equal((await call('GET', '/app.js')).status, 200);
  assert.equal((await call('GET', '/..%2fserver.js')).status, 404);
  assert.equal((await call('GET', '/photos/AAAAAA/x.jpg')).status, 404); // no public photo path at all
  assert.equal((await call('GET', '/nope.txt')).status, 404);
  assert.equal((await call('POST', '/api/games', { json: { playerName: 'x' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('POST', '/api/games', { json: { playerName: 'x' }, headers: { Origin: 'null' } })).status, 403);
});

test('scoring: totals, shared places, category winners', () => {
  const game = {
    categories: [{ id: 'beer', label: 'בירה' }, { id: 'food', label: 'אוכל' }, { id: 'view', label: 'נוף' }],
    players: [{ id: 'a', name: 'אבי', status: 'in' }, { id: 'b', name: 'בני', status: 'in' }, { id: 'c', name: 'גיל', status: 'in' }, { id: 'd', name: 'דן', status: 'out' }],
    entries: [
      { playerId: 'a', cat: 'beer', ts: 1 }, { playerId: 'a', cat: 'beer', ts: 2 }, { playerId: 'a', cat: 'food', ts: 3 },
      { playerId: 'b', cat: 'food', ts: 4 }, { playerId: 'b', cat: 'food', ts: 5 }, { playerId: 'b', cat: 'beer', ts: 6 },
    ],
  };
  assert.deepEqual(scores(game).a, { total: 3, byCat: { beer: 2, food: 1 }, last: 3 });
  const all = ranking(game);
  assert.deepEqual(all.map((r) => [r.player.id, r.count, r.place]), [['a', 3, 1], ['b', 3, 1], ['c', 0, 3]]); // דן left with no points: not listed
  assert.deepEqual(ranking(game, 'beer').map((r) => [r.player.id, r.place]), [['a', 1], ['b', 2], ['c', 3]]);
  const winners = categoryWinners(game);
  assert.deepEqual(winners.map((w) => [w.cat.id, w.count, w.winners.map((p) => p.id)]), [['beer', 2, ['a']], ['food', 2, ['b']], ['view', 0, []]]);
});

// ----- attacks -----

async function miniServer(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-sec-'));
  const mini = createApp({ dataDir: dir, ...options });
  await new Promise((r) => mini.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${mini.server.address().port}`;
  const req = async (method, p, { json, raw, token, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (json) h['Content-Type'] = 'application/json';
    const res = await fetch(url + p, { method, headers: h, body: json ? JSON.stringify(json) : raw });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const stop = async () => {
    mini.server.closeAllConnections();
    await new Promise((r) => mini.server.close(r));
    await mini.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { mini, url, req, stop, dir };
}

test('attack: a made-up X-Forwarded-For does not reset the rate limit', async () => {
  const { req, stop } = await miniServer({ createsPerHour: 2 });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await req('POST', '/api/games', { json: { playerName: 'a' }, headers: { 'X-Forwarded-For': `10.0.0.${i}` } })).status);
  assert.deepEqual(statuses, [201, 201, 429, 429]);
  await stop();
});

test('behind a trusted proxy the real client address is the one the proxy appended', async () => {
  const { req, stop } = await miniServer({ createsPerHour: 1, trustProxy: 1 });
  const from = (xff) => req('POST', '/api/games', { json: { playerName: 'a' }, headers: { 'X-Forwarded-For': xff } }).then((r) => r.status);
  assert.equal(await from('1.1.1.1'), 201);
  assert.equal(await from('2.2.2.2'), 201); // a different visitor
  assert.equal(await from('9.9.9.9, 1.1.1.1'), 429); // the left part is typed by the client and ignored
  await stop();
});

test('attack: guessing game codes locks the guesser out', async () => {
  const { req, stop } = await miniServer({ codeMisses: 5 });
  const real = (await req('POST', '/api/games', { json: { playerName: 'בוס' } })).body;
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await req('POST', `/api/games/AAAA${i + 2}B/join`, { json: { playerName: 'x' } })).status);
  assert.deepEqual(statuses, [404, 404, 404, 404, 404, 429, 429]);
  // Locked out even for a code that exists: no oracle left.
  assert.equal((await req('POST', `/api/games/${real.code}/join`, { json: { playerName: 'x' } })).status, 429);
  await stop();
});

test('attack: flooding one waiting list from one phone', async () => {
  const { req, stop } = await miniServer({ joinsPerGameHour: 3 });
  const g = (await req('POST', '/api/games', { json: { playerName: 'בוס' } })).body;
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await req('POST', `/api/games/${g.code}/join`, { json: { playerName: `טרול ${i}` } })).status);
  assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
  await stop();
});

test('the waiting list has a ceiling', async () => {
  const g = await newGame();
  const statuses = [];
  for (let i = 0; i < 27; i++) statuses.push((await call('POST', `/api/games/${g.code}/join`, { json: { playerName: `p${i}` } })).status);
  assert.equal(statuses.filter((x) => x === 201).length, 25);
  assert.deepEqual(statuses.slice(25), [409, 409]);
});

test('attack: posing as the boss - names are unique inside a game', async () => {
  const g = await newGame();
  const fake = await joinAs(g.code, 'בוס');
  const fake2 = await joinAs(g.code, '  בוס​ ');
  const host = await state(g.code, g.token);
  assert.deepEqual(host.players.map((p) => p.name), ['בוס', 'בוס 2', 'בוס 3']);
  assert.equal((await state(g.code, fake.token)).me.name, 'בוס 2');
  assert.equal((await state(g.code, fake2.token)).me.name, 'בוס 3');
});

test('attack: invisible and direction-flipping characters in names', async () => {
  assert.equal(cleanText('​‎﻿', 20), '');
  assert.equal((await call('POST', '/api/games', { json: { playerName: '​⁠­' } })).status, 400);
  assert.equal(cleanText('דני‮<script>', 20), 'דני <script>'); // stored as text, shown as text
  assert.equal(cleanText('👨‍👩‍👧‍👦'.repeat(30), 3), '👨‍👩'); // cut by character, never mid-surrogate
});

test('attack: parallel uploads cannot beat the cooldown', async () => {
  const g = await newGame();
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  tick();
  const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', `/api/games/${g.code}/entries?cat=beer`, { token: g.token, raw: JPEG })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 429).length, 7);
  assert.equal((await state(g.code, g.token)).entries.length, 1);
});

test('attack: filling the disk - the storage quota stops uploads', async () => {
  const { req, stop, mini } = await miniServer({ maxTotalBytes: 150 });
  let t = Date.now();
  const g = (await req('POST', '/api/games', { json: { playerName: 'בוס' } })).body;
  await req('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  const up = () => req('POST', `/api/games/${g.code}/entries?cat=beer`, { token: g.token, raw: JPEG, headers: { 'Content-Type': 'image/jpeg' } });
  const game = mini.games.get(g.code);
  const skipCooldown = () => { for (const p of game.players) p.lastEntryAt = 0; };
  assert.equal((await up()).status, 201); skipCooldown();
  assert.equal((await up()).status, 201); skipCooldown();
  assert.equal(mini.stats().totalBytes, 2 * JPEG.length);
  assert.equal((await up()).status, 201); skipCooldown(); // 136 bytes so far, under 150
  assert.equal((await up()).status, 507);
  // Deleting frees the space again.
  const id = (await req('GET', `/api/games/${g.code}`, { token: g.token })).body.entries[0].id;
  assert.equal((await req('DELETE', `/api/games/${g.code}/entries/${id}`, { token: g.token })).status, 200);
  assert.equal((await up()).status, 201);
  await stop();
});

test('attack: too many games - the server stops accepting new ones', async () => {
  const { req, stop } = await miniServer({ maxGames: 2 });
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await req('POST', '/api/games', { json: { playerName: 'a' } })).status);
  assert.deepEqual(statuses, [201, 201, 503]);
  await stop();
});

test('attack: request flood from one address', async () => {
  const { url, stop } = await miniServer({ requestsPerMinute: 10 });
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await fetch(`${url}/api/health`)).status);
  assert.deepEqual(statuses.slice(9), [200, 429, 429]);
  await stop();
});

test('attack: opening endless live streams - old ones are closed', async () => {
  const { url, mini, stop } = await miniServer({});
  const g = await (await fetch(`${url}/api/games`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName: 'a' }) })).json();
  const open = [];
  for (let i = 0; i < 7; i++) {
    const res = await fetch(`${url}/api/games/${g.code}/events`, { headers: { Authorization: `Bearer ${g.token}` } });
    assert.equal(res.status, 200);
    open.push(res);
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(mini.stats().streams, 4);
  for (const res of open) await res.body.cancel().catch(() => {});
  await stop();
});

test('attack: oversized and malformed requests', async () => {
  const g = await newGame();
  assert.equal((await call('POST', '/api/games', { json: { playerName: 'a', name: 'x'.repeat(20000) } })).status, 413);
  assert.equal((await call('POST', '/api/games', { headers: { 'Content-Type': 'application/json' }, raw: Buffer.from('[1,2,3]') })).status, 400);
  assert.equal((await call('POST', '/api/games', { headers: { 'Content-Type': 'application/json' }, raw: Buffer.from('"str"') })).status, 400);
  assert.equal((await call('POST', '/api/games', { json: { playerName: { $ne: null } } })).status, 400);
  assert.equal((await call('POST', '/api/games', { json: { playerName: 'a', categories: Array.from({ length: 13 }, (_, i) => ({ label: `c${i}` })) } })).status, 400);
  assert.equal((await call('POST', '/api/games', { json: { playerName: 'a', categories: 'beer' } })).status, 400);
  assert.equal((await call('GET', `/api/games/${g.code}`, { token: 'x'.repeat(5000) })).status, 401);
  assert.equal((await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { playerId: { length: 1 } } })).status, 404);
  assert.equal((await call('POST', `/api/games/${g.code}/kick`, { token: g.token, json: { playerId: '__proto__' } })).status, 404);
  assert.equal((await call('DELETE', `/api/games/${g.code}/entries/__proto__`, { token: g.token })).status, 404);
  assert.equal((await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: { hours: 1e308 } })).status, 200);
  const s = await state(g.code, g.token);
  assert.equal(s.endsAt - s.startedAt, 14 * 24 * 3600_000); // capped at two weeks
  assert.equal(Object.prototype.polluted, undefined);
});

test('attack: __proto__ in a JSON body does not pollute anything', async () => {
  const res = await call('POST', '/api/games', { headers: { 'Content-Type': 'application/json' }, raw: Buffer.from('{"playerName":"a","__proto__":{"polluted":1},"categories":[{"label":"x","__proto__":{"polluted":1}}]}') });
  assert.equal(res.status, 201);
  assert.equal({}.polluted, undefined);
});

test('photos: an upload that is HTML inside a JPEG is still served as a harmless image', async () => {
  const g = await newGame();
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  const polyglot = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('<html><script>alert(document.domain)</script>')]);
  assert.equal((await point(g.code, g.token, 'beer', polyglot)).status, 201);
  const photo = await call('GET', (await state(g.code, g.token)).entries[0].photo, { token: g.token });
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal(photo.headers.get('x-content-type-options'), 'nosniff');
  assert.match(photo.headers.get('content-security-policy'), /default-src 'none'; sandbox/);
  assert.equal(photo.headers.get('cross-origin-resource-policy'), 'same-origin');
});

test('privacy: waiting, removed and outside players learn nothing about the photos', async () => {
  const g = await newGame();
  const dana = await joinAs(g.code, 'דנה'), troll = await joinAs(g.code, 'טרול');
  await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { playerId: dana.playerId } });
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  await point(g.code, dana.token);
  // A photo link opens only with a member's token: not bare, not for the waiting list,
  // not for a member of another game, and not for a file from another game.
  const link = (await state(g.code, g.token)).entries[0].photo;
  const other = await newGame();
  assert.equal((await call('GET', link, { token: dana.token })).status, 200);
  assert.equal((await call('GET', link)).status, 401);
  assert.equal((await call('GET', `${link}?token=${dana.token}`)).status, 401);
  assert.equal((await call('GET', link, { token: troll.token })).status, 403);
  assert.equal((await call('GET', link, { token: other.token })).status, 401);
  assert.equal((await call('GET', link.replace(g.code, other.code), { token: other.token })).status, 404);
  assert.equal((await call('GET', `/api/games/${g.code}/photos/..%2f..%2fgames%2f${g.code}.json`, { token: g.token })).status, 404);
  assert.equal((await call('GET', link.replace('/api/games/', '/').replace('/photos/', '/').replace(/^\/(\w+)\//, '/photos/$1/'))).status, 404);
  for (const token of [troll.token]) {
    const s = await state(g.code, token);
    assert.deepEqual([s.entries, s.players], [[], []]);
    assert.equal(JSON.stringify(s).includes('/photos/'), false);
  }
  await call('POST', `/api/games/${g.code}/kick`, { token: g.token, json: { playerId: dana.playerId } });
  assert.equal((await call('GET', link, { token: dana.token })).status, 403); // removed: the link she had is dead
  const out = await state(g.code, dana.token);
  assert.deepEqual([out.me.status, out.entries, out.players], ['out', [], []]);
  // Nothing in any view ever carries a token or its hash, or another player's secrets.
  const host = JSON.stringify(await state(g.code, g.token));
  for (const secret of [dana.token, troll.token, g.token, 'tokenHash', 'lastEntryAt']) assert.equal(host.includes(secret), false);
});

test('a whole party on one Wi-Fi: the default limits let 25 friends join and play from one address', async () => {
  const { req, stop } = await miniServer({}); // default limits, everyone from 127.0.0.1
  const g = (await req('POST', '/api/games', { json: { playerName: 'בוס' } })).body;
  const friends = [];
  for (let i = 0; i < 25; i++) {
    const res = await req('POST', `/api/games/${g.code}/join`, { json: { playerName: `חבר ${i}` } });
    assert.equal(res.status, 201);
    friends.push(res.body);
  }
  assert.equal((await req('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { all: true } })).status, 200);
  assert.equal((await req('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} })).status, 200);
  // Everyone refreshes a lot: 26 players x 40 requests, all from the same address.
  const statuses = await Promise.all([g, ...friends].flatMap((f) => Array.from({ length: 40 }, () => req('GET', `/api/games/${g.code}`, { token: f.token }).then((r) => r.status))));
  assert.equal(statuses.every((x) => x === 200), true);
  await stop();
});

test('attack: one player hammering the API is slowed down without hurting the others', async () => {
  const { req, url, stop } = await miniServer({ playerRequestsPerMinute: 20 });
  const g = (await req('POST', '/api/games', { json: { playerName: 'בוס' } })).body;
  const dana = (await req('POST', `/api/games/${g.code}/join`, { json: { playerName: 'דנה' } })).body;
  const statuses = [];
  for (let i = 0; i < 25; i++) statuses.push((await req('GET', `/api/games/${g.code}`, { token: dana.token })).status);
  assert.deepEqual([statuses.filter((x) => x === 200).length, statuses.filter((x) => x === 429).length], [20, 5]);
  const limited = await fetch(`${url}/api/games/${g.code}`, { headers: { Authorization: `Bearer ${dana.token}` } });
  assert.equal(limited.headers.get('retry-after'), '10');
  assert.equal((await req('GET', `/api/games/${g.code}`, { token: g.token })).status, 200); // the boss is fine
  await stop();
});

test('installable: the manifest and every icon it names are served', async () => {
  const res = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /manifest\+json/);
  const manifest = await res.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png'), true);
  assert.equal(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'), true);
  for (const icon of [...manifest.icons.map((i) => i.src), 'apple-touch-icon.png']) {
    const file = await fetch(`${base}/${icon}`);
    assert.equal(file.status, 200, icon);
    if (icon.endsWith('.png')) assert.equal(sniffImage(Buffer.from(await file.arrayBuffer())), 'png', icon);
  }
});

test('housekeeping: abandoned games end and old ones are deleted with their photos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-old-'));
  let t = Date.now();
  const old = createApp({ dataDir: dir, now: () => t });
  await new Promise((r) => old.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${old.server.address().port}`;
  const post = async (p, token, body, type = 'application/json') => {
    const res = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': type, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body });
    return res.json();
  };
  const DAY = 24 * 3600_000;
  const lobby = await post('/api/games', null, JSON.stringify({ playerName: 'a' }));
  const played = await post('/api/games', null, JSON.stringify({ playerName: 'b' }));
  await post(`/api/games/${played.code}/start`, played.token, '{}');
  t += 4000;
  await post(`/api/games/${played.code}/entries?cat=beer`, played.token, JPEG, 'image/jpeg');
  const photoDir = path.join(dir, 'photos', played.code);
  assert.equal(fs.readdirSync(photoDir).length, 1);

  t += 6 * DAY; old.sweep();
  assert.deepEqual([old.games.has(lobby.code), old.games.get(played.code).status], [true, 'active']);
  t += 2 * DAY; old.sweep(); // 8 days: the lobby nobody started is gone
  assert.equal(old.games.has(lobby.code), false);
  t += 7 * DAY; old.sweep(); // 15 days: the game nobody ended is over
  assert.equal(old.games.get(played.code).status, 'ended');
  assert.equal(fs.readdirSync(photoDir).length, 1); // results and photos stay for a month
  t += 29 * DAY; old.sweep();
  assert.equal(old.games.has(played.code), true);
  t += 2 * DAY; old.sweep();
  assert.equal(old.games.has(played.code), false);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(photoDir), false);
  assert.equal(old.stats().totalBytes, 0);
  await new Promise((r) => old.server.close(r));
  await old.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('housekeeping: after a crash, stray photo files and photo-less points are cleaned up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-crash-'));
  const first = createApp({ dataDir: dir });
  await new Promise((r) => first.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${first.server.address().port}`;
  const g = await (await fetch(`${url}/api/games`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName: 'a' }) })).json();
  const auth = { Authorization: `Bearer ${g.token}` };
  await fetch(`${url}/api/games/${g.code}/start`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
  const game = first.games.get(g.code);
  for (let i = 0; i < 2; i++) {
    game.players[0].lastEntryAt = 0;
    assert.equal((await fetch(`${url}/api/games/${g.code}/entries?cat=beer`, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: JPEG })).status, 201);
  }
  await new Promise((r) => first.server.close(r));
  await first.flush();

  // The mess a crash can leave behind:
  const photoDir = path.join(dir, 'photos', g.code);
  fs.writeFileSync(path.join(photoDir, 'stray.jpg'), JPEG); // written, never recorded
  fs.rmSync(path.join(photoDir, game.entries[0].file)); // recorded, file lost
  fs.mkdirSync(path.join(dir, 'photos', 'GHOST9'));
  fs.writeFileSync(path.join(dir, 'photos', 'GHOST9', 'x.jpg'), JPEG); // a game that no longer exists
  fs.writeFileSync(path.join(dir, 'games', 'BROKEN.json'), '{"code":"BRO'); // half-written

  const second = createApp({ dataDir: dir });
  const again = second.games.get(g.code);
  assert.equal(again.entries.length, 1);
  assert.deepEqual(fs.readdirSync(photoDir), [again.entries[0].file]);
  assert.equal(fs.existsSync(path.join(dir, 'photos', 'GHOST9')), false);
  assert.equal(second.stats().totalBytes, JPEG.length);
  assert.equal(second.games.size, 1);
  second.server.close();
  await second.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('thumbnails: a small copy rides in front of the photo and is served to members only', async () => {
  const g = await newGame();
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  const up = (thumbBytes, body) => { tick(); return call('POST', `/api/games/${g.code}/entries?cat=beer`, { token: g.token, raw: body, headers: thumbBytes === null ? {} : { 'X-Thumb-Bytes': String(thumbBytes) } }); };
  const small = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 7)]);

  assert.equal((await up(small.length, Buffer.concat([small, PNG]))).status, 201);
  assert.equal((await up(null, JPEG)).status, 201); // an older app without thumbnails still works
  // Lies about the split are refused: junk as the thumbnail, junk as the photo, silly sizes.
  assert.equal((await up(10, Buffer.concat([Buffer.alloc(10, 1), JPEG]))).status, 400);
  assert.equal((await up(small.length, Buffer.concat([small, Buffer.from('not a photo')]))).status, 400);
  assert.equal((await up(small.length, small)).status, 400); // nothing after the thumbnail
  for (const bad of ['-5', '1.5', 'abc', String(10 * 1024 * 1024)]) assert.equal((await up(bad, JPEG)).status, 400, bad);

  const s = await state(g.code, g.token);
  assert.equal(s.entries.length, 2);
  const [withThumb, without] = s.entries;
  assert.notEqual(withThumb.thumb, withThumb.photo);
  assert.equal(without.thumb, without.photo);
  const thumb = await call('GET', withThumb.thumb, { token: g.token });
  assert.equal(Buffer.from(thumb.body).equals(small), true);
  assert.equal(Buffer.from((await call('GET', withThumb.photo, { token: g.token })).body).equals(PNG), true);
  assert.equal((await call('GET', withThumb.thumb)).status, 401);

  // Deleting the point removes both files.
  assert.equal((await call('DELETE', `/api/games/${g.code}/entries/${withThumb.id}`, { token: g.token })).status, 200);
  assert.equal((await call('GET', withThumb.thumb, { token: g.token })).status, 404);
  assert.equal((await call('GET', withThumb.photo, { token: g.token })).status, 404);
  await app.flush();
  assert.equal(fs.readdirSync(path.join(dataDir, 'photos', g.code)).length, 1);
});

test('rematch: the boss opens another round and the old members walk straight in', async () => {
  const g = await newGame({ categories: [{ id: 'pizza', emoji: '🍕', label: 'פיצה' }] });
  const dana = await joinAs(g.code, 'דנה'), yossi = await joinAs(g.code, 'יוסי'), stranger = await joinAs(g.code, 'זר');
  await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { playerId: dana.playerId } });
  await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { playerId: yossi.playerId } });
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  const rematch = (token) => call('POST', `/api/games/${g.code}/rematch`, { token });

  assert.equal((await rematch(g.token)).status, 409); // not over yet
  await call('POST', `/api/games/${g.code}/kick`, { token: g.token, json: { playerId: yossi.playerId } });
  await call('POST', `/api/games/${g.code}/end`, { token: g.token });
  assert.equal((await rematch(dana.token)).status, 409); // only the boss opens it
  assert.equal((await state(g.code, dana.token)).rematch, undefined);

  const opened = await rematch(g.token);
  assert.equal(opened.status, 201);
  assert.notEqual(opened.body.code, g.code);
  assert.equal((await rematch(g.token)).status, 409); // one rematch per game
  const fresh = await state(opened.body.code, opened.body.token);
  assert.deepEqual([fresh.status, fresh.name, fresh.me.isHost, fresh.me.name], ['lobby', 'ערב שישי', true, 'בוס']);
  assert.deepEqual(fresh.categories, [{ id: 'pizza', emoji: '🍕', label: 'פיצה' }]);
  assert.deepEqual(fresh.entries, []);

  assert.deepEqual((await state(g.code, dana.token)).rematch, { code: opened.body.code, joined: false });
  const in2 = await rematch(dana.token);
  assert.equal(in2.status, 201);
  const hers = await state(in2.body.code, in2.body.token);
  assert.deepEqual([hers.me.status, hers.me.name, hers.me.isHost], ['in', 'דנה', false]); // no waiting list
  assert.equal((await rematch(dana.token)).status, 409); // one ticket per player
  assert.deepEqual((await state(g.code, dana.token)).rematch, { code: opened.body.code, joined: true });

  // No ticket for the removed player, for the one who never got in, or for a token of the new game.
  assert.equal((await rematch(yossi.token)).status, 403);
  assert.equal((await rematch(stranger.token)).status, 403);
  assert.equal((await rematch(in2.body.token)).status, 401);
  assert.equal((await state(g.code, stranger.token)).rematch, undefined);
  assert.deepEqual((await state(opened.body.code, opened.body.token)).players.map((p) => p.name), ['בוס', 'דנה']);

  // Once the rematch itself is over it is no longer offered.
  await call('POST', `/api/games/${opened.body.code}/start`, { token: opened.body.token, json: {} });
  await call('POST', `/api/games/${opened.body.code}/end`, { token: opened.body.token });
  assert.equal((await state(g.code, dana.token)).rematch, undefined);
});

test('reactions: tap to add, tap again to remove, counts only', async () => {
  const g = await newGame();
  const dana = await joinAs(g.code, 'דנה'), troll = await joinAs(g.code, 'טרול');
  await call('POST', `/api/games/${g.code}/approve`, { token: g.token, json: { playerId: dana.playerId } });
  await call('POST', `/api/games/${g.code}/start`, { token: g.token, json: {} });
  const id = (await point(g.code, dana.token)).body.id;
  const react = (token, emoji, entry = id) => call('POST', `/api/games/${g.code}/entries/${entry}/react`, { token, json: { emoji } });

  assert.deepEqual((await react(g.token, '🔥')).body.reactions, { '🔥': { n: 1, mine: true } });
  assert.deepEqual((await react(dana.token, '🔥')).body.reactions, { '🔥': { n: 2, mine: true } });
  await react(dana.token, '😂');
  assert.deepEqual((await state(g.code, g.token)).entries[0].reactions, { '🔥': { n: 2, mine: true }, '😂': { n: 1, mine: false } });
  assert.deepEqual((await react(g.token, '🔥')).body.reactions, { '🔥': { n: 1, mine: false }, '😂': { n: 1, mine: false } }); // taken back
  await react(dana.token, '😂');
  assert.deepEqual((await state(g.code, dana.token)).entries[0].reactions, { '🔥': { n: 1, mine: true } });

  // Only the fixed set, only members, only real photos; ids of who reacted never leave the server.
  for (const emoji of ['💩', '<script>', '', 5, null, ['🔥'], '__proto__', 'constructor']) assert.equal((await react(g.token, emoji)).status, 400, String(emoji));
  assert.equal((await react(troll.token, '🔥')).status, 403);
  assert.equal((await react(g.token, '🔥', 'nope')).status, 404);
  assert.equal((await call('POST', `/api/games/${g.code}/entries/${id}/react`, { json: { emoji: '🔥' } })).status, 401);
  assert.equal(JSON.stringify((await state(g.code, g.token)).entries).includes(dana.playerId + '"]'), false);

  // Still possible after the final whistle.
  await call('POST', `/api/games/${g.code}/end`, { token: g.token });
  assert.equal((await react(g.token, '👏')).status, 200);
});
