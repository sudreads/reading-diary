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
  app = createApp({ dataDir, now: () => clock, createsPerHour: 1000, joinsPerMinute: 1000 });
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

test('create a game: host is in, default categories, 5-letter code', async () => {
  const g = await newGame();
  assert.match(g.code, /^[A-HJ-NP-Z2-9]{5}$/);
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
  assert.equal((await call('GET', '/api/games/ZZZZZ', { token: a.token })).status, 404);
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
  assert.match(s.entries[0].photo, new RegExp(`^/photos/${g.code}/[\\w-]+\\.png$`));
  const photo = await call('GET', s.entries[0].photo);
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
  assert.equal((await call('GET', file)).status, 404); // the file goes too
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
  const res = await fetch(`${base}/api/games/${g.code}/events?token=${g.token}`);
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
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await call('GET', '/app.js')).status, 200);
  assert.equal((await call('GET', '/..%2fserver.js')).status, 404);
  assert.equal((await call('GET', '/photos/AAAAA/..%2f..%2fgames%2fx.json')).status, 404);
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
