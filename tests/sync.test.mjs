import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync, withSyncLock, backoffMs } from '../js/sync.js';
import { fakeDrive, fakeStore, rng, uuid } from './fakes.mjs';

const live = (store, kind) => [...store.data[kind].values()].filter((r) => !r.deleted);

function book(store, title) {
  return store.write('books', { id: uuid(), title, status: 'reading' });
}

test('two devices syncing in random interleavings never lose a record', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed);
    const drive = fakeDrive(rand);
    const A = fakeStore('dev-a', rand), B = fakeStore('dev-b', rand);
    const a1 = book(A, 'A1'), b1 = book(B, 'B1');
    await Promise.all([
      runSync({ store: A, drive, deviceId: 'dev-a' }),
      runSync({ store: B, drive, deviceId: 'dev-b' }),
    ]);
    await runSync({ store: B, drive, deviceId: 'dev-b' }); // the UI can only edit books it has
    const a2 = book(A, 'A2');
    A.write('books', { id: a1.id, title: 'A1 renamed by A' });
    B.write('books', { id: a1.id, title: 'A1 renamed by B' }); // concurrent: one wins, the same one on both
    await Promise.all([
      runSync({ store: A, drive, deviceId: 'dev-a' }),
      runSync({ store: B, drive, deviceId: 'dev-b' }),
    ]);
    // A final quiet round each so everyone has seen everyone.
    await runSync({ store: A, drive, deviceId: 'dev-a' });
    await runSync({ store: B, drive, deviceId: 'dev-b' });
    await runSync({ store: A, drive, deviceId: 'dev-a' });
    for (const S of [A, B]) {
      const ids = live(S, 'books').map((r) => r.id).sort();
      assert.deepEqual(ids, [a1.id, b1.id, a2.id].sort(), `seed ${seed} ${S.deviceId}`);
      assert.match(S.data.books.get(a1.id).title, /^A1 renamed by [AB]$/, `seed ${seed}`);
    }
    assert.equal(JSON.stringify(A.data.books.get(a1.id)), JSON.stringify(B.data.books.get(a1.id)));
  }
});

test('each device only ever writes its own file', async () => {
  const rand = rng(7);
  const drive = fakeDrive(rand);
  const A = fakeStore('dev-a', rand), B = fakeStore('dev-b', rand);
  book(A, 'x'); book(B, 'y');
  await runSync({ store: A, drive, deviceId: 'dev-a' });
  await runSync({ store: B, drive, deviceId: 'dev-b' });
  await runSync({ store: A, drive, deviceId: 'dev-a' });
  const names = [...drive.files.values()].map((f) => f.name).sort();
  assert.deepEqual(names, ['device-dev-a.json', 'device-dev-b.json']);
});

test('an edit made during a sync cycle stays not-backed-up and goes up next cycle', async () => {
  const rand = rng(3);
  const drive = fakeDrive(rand);
  const A = fakeStore('dev-a', rand);
  book(A, 'first');
  const realUpload = drive.uploadDeviceFile;
  let late;
  drive.uploadDeviceFile = async (...args) => {
    late = book(A, 'written mid-sync'); // lands after the snapshot was taken
    return realUpload(...args);
  };
  await runSync({ store: A, drive, deviceId: 'dev-a' });
  assert.ok(A.meta.get('syncedThroughGen') < A.meta.get('mutationGen'), 'must still be dirty');
  drive.uploadDeviceFile = realUpload;
  await runSync({ store: A, drive, deviceId: 'dev-a' });
  assert.equal(A.meta.get('syncedThroughGen'), A.meta.get('mutationGen'));
  const remote = JSON.parse([...drive.files.values()][0].body);
  assert.ok(remote.books.some((b) => b.id === late.id));
});

test('a failed upload confirmation leaves the device dirty', async () => {
  const rand = rng(5);
  const drive = fakeDrive(rand);
  const A = fakeStore('dev-a', rand);
  book(A, 'x');
  drive.getFileMeta = async () => null;
  await assert.rejects(runSync({ store: A, drive, deviceId: 'dev-a' }), /upload-not-confirmed/);
  assert.equal(A.meta.get('syncedThroughGen'), undefined);
});

test('a new phone gets everything back from Drive', async () => {
  const rand = rng(11);
  const drive = fakeDrive(rand);
  const old = fakeStore('old-phone', rand);
  const b = book(old, 'Rich Dad Poor Dad');
  old.write('blocks', { id: uuid(), bookId: b.id, type: 'lesson', text: 'Buy assets', rank: 'i' });
  await runSync({ store: old, drive, deviceId: 'old-phone' });
  const fresh = fakeStore('new-phone', rand);
  await runSync({ store: fresh, drive, deviceId: 'new-phone' });
  assert.equal(live(fresh, 'books')[0].title, 'Rich Dad Poor Dad');
  assert.equal(live(fresh, 'blocks')[0].text, 'Buy assets');
});

test('a device file from a newer app version is not merged', async () => {
  const rand = rng(13);
  const drive = fakeDrive(rand);
  await drive.uploadDeviceFile(null, 'device-future.json', { app: 'reading-diary', schemaVersion: 2, books: [{ id: uuid(), title: 'x' }] });
  const A = fakeStore('dev-a', rand);
  const res = await runSync({ store: A, drive, deviceId: 'dev-a' });
  assert.ok(res.notes.includes('newer-app-on-other-device'));
  assert.equal(A.data.books.size, 0);
});

test('drawings upload once, before the journal that references them', async () => {
  const rand = rng(17);
  const drive = fakeDrive(rand);
  const A = fakeStore('dev-a', rand);
  const id = uuid();
  A.drawings.set(id, { blob: 'img', uploaded: false });
  await runSync({ store: A, drive, deviceId: 'dev-a' });
  await runSync({ store: A, drive, deviceId: 'dev-a' });
  assert.equal([...drive.files.values()].filter((f) => f.name === `drawing-${id}.webp`).length, 1);
  assert.equal(A.drawings.get(id).uploaded, true);
});

test('two tabs on one device never run overlapping cycles', async () => {
  let held = false, ran = 0, overlapped = false;
  const locks = {
    async request(name, opts, cb) {
      if (held) return cb(null);
      held = true;
      try { return await cb({ name }); } finally { held = false; }
    },
  };
  const job = () => withSyncLock(locks, async () => {
    if (ran++ && held === false) overlapped = true;
    await new Promise((r) => setTimeout(r, 5));
    return { ok: true };
  });
  const [r1, r2] = await Promise.all([job(), job()]);
  assert.equal(overlapped, false);
  assert.equal(ran, 1);
  assert.ok(r1.ok !== r2.ok);
  assert.ok([r1, r2].some((r) => r.busy));
});

test('backoff grows from 30 s and caps at 30 min', () => {
  assert.equal(backoffMs(1), 30000);
  assert.equal(backoffMs(2), 60000);
  assert.equal(backoffMs(20), 1800000);
});

test('an unreadable device file is skipped without blocking sync', async () => {
  const rand = rng(19);
  const drive = fakeDrive(rand);
  await drive.uploadDeviceFile(null, 'device-broken.json', ['not', 'an', 'object']);
  const A = fakeStore('dev-a', rand);
  book(A, 'x');
  const res = await runSync({ store: A, drive, deviceId: 'dev-a' });
  assert.ok(res.notes.includes('unreadable-device-file'));
  assert.equal(A.meta.get('syncedThroughGen'), A.meta.get('mutationGen'));
});
