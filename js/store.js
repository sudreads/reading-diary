// IndexedDB-backed local store. Every user write stamps a revision and bumps mutationGen in the
// same transaction, so "backed up" is exactly "syncedThroughGen === mutationGen".

import { nextRev, maxT } from './rev.js';
import { mergeRecord, sameRecord, KINDS } from './merge.js';
import { additiveRestore } from './validate.js';

const DB_NAME = 'reading-diary';
const DB_VERSION = 1;
let db;
const listeners = new Set();

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export async function open() {
  db = await new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      // Additive only: later versions add stores/indexes, never drop or rewrite these.
      for (const k of [...KINDS, 'drawings']) if (!d.objectStoreNames.contains(k)) d.createObjectStore(k, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Close other Reading Diary tabs and reopen'));
  });
  db.onversionchange = () => db.close();
  if (!(await getMeta('deviceId'))) await setMeta('deviceId', crypto.randomUUID());
  return db;
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Sign out: after kill() every store call throws (db is null), so a stale tab can't write the old
// diary back. The deleted database is the durable barrier - reopening starts empty.
export function kill() {
  if (db) db.close();
  db = null;
  listeners.clear();
}

function deleteDb(name) {
  return new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error || new Error(`could not delete ${name}`));
    r.onblocked = () => rej(new Error('blocked'));
  });
}

export async function wipe() {
  kill();
  await deleteDb(DB_NAME);
  // Not firebaseLocalStorageDb: the Firebase SDK in this very tab keeps it open (always "blocked").
  // Firebase's signOut() clears the saved session there; the caller verifies that first.
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('rd-')) localStorage.removeItem(k);
  } catch { /* storage blocked: nothing of ours is in it then */ }
}
const emit = (why) => listeners.forEach((fn) => fn(why));

export async function getMeta(key, dflt) {
  const row = await req(db.transaction('meta').objectStore('meta').get(key));
  return row ? row.value : dflt;
}

export async function setMeta(key, value) {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await done(tx);
}

export async function all(kind) {
  return req(db.transaction(kind).objectStore(kind).getAll());
}

export async function list(kind) {
  return (await all(kind)).filter((r) => !r.deleted);
}

export async function get(kind, id) {
  const r = await req(db.transaction(kind).objectStore(kind).get(id));
  return r && !r.deleted ? r : null;
}

async function write(kind, id, change) {
  const tx = db.transaction([kind, 'meta'], 'readwrite');
  const store = tx.objectStore(kind), meta = tx.objectStore('meta');
  const [hi, gen, dev, prev] = await Promise.all([
    req(meta.get('highestT')), req(meta.get('mutationGen')), req(meta.get('deviceId')), req(store.get(id)),
  ]);
  const rev = nextRev(hi ? hi.value : 0, dev.value);
  const next = change(prev || { id }, rev);
  store.put(next);
  meta.put({ key: 'highestT', value: rev.t });
  meta.put({ key: 'mutationGen', value: (gen ? gen.value : 0) + 1 });
  await done(tx);
  emit(kind);
  return next;
}

export function save(kind, rec) {
  return write(kind, rec.id || crypto.randomUUID(), (prev, rev) => {
    const next = { ...prev, ...rec, id: prev.id, rev };
    if ('rank' in rec) next.rankRev = rev;
    return next;
  });
}

export function setRank(id, rank) {
  return write('blocks', id, (prev, rev) => ({ ...prev, rank, rankRev: rev }));
}

export function remove(kind, id) {
  return write(kind, id, (prev, rev) => ({ ...prev, deleted: true, rev }));
}

// Including tombstones - the review outbox needs a deleted book's work id to delete its review.
export async function getRaw(kind, id) {
  return (await req(db.transaction(kind).objectStore(kind).get(id))) || null;
}

// Review outbox: bookId -> generation. Bump and ack each run in one transaction so a bump that
// lands while a write is in flight can never be erased by that write's ack.
export async function outboxBump(bookId) {
  const tx = db.transaction('meta', 'readwrite');
  const meta = tx.objectStore('meta');
  const row = await req(meta.get('reviewOutbox'));
  const box = row ? row.value : {};
  box[bookId] = (box[bookId] || 0) + 1;
  meta.put({ key: 'reviewOutbox', value: box });
  await done(tx);
  emit('outbox');
}

export async function outboxAck(bookId, gen) {
  const tx = db.transaction('meta', 'readwrite');
  const meta = tx.objectStore('meta');
  const row = await req(meta.get('reviewOutbox'));
  const box = row ? row.value : {};
  const cleared = box[bookId] === gen;
  if (cleared) { delete box[bookId]; meta.put({ key: 'reviewOutbox', value: box }); }
  await done(tx);
  return cleared;
}

export async function snapshot() {
  const out = {};
  for (const k of KINDS) out[k] = await all(k);
  return out;
}

// Merge remote records in one transaction, re-reading each local record inside it so a write
// that landed during the download is merged, not overwritten. capClock (restore) still advances
// the clock past imported records so later edits beat them, but never beyond the wall clock.
export async function mergeIn(state, { capClock = false } = {}) {
  const tx = db.transaction([...KINDS, 'meta'], 'readwrite');
  let changed = false;
  for (const k of KINDS) {
    const store = tx.objectStore(k);
    for (const r of state[k] || []) {
      const local = await req(store.get(r.id));
      const merged = mergeRecord(local, r);
      if (!sameRecord(local, merged)) { store.put(merged); changed = true; }
    }
  }
  const meta = tx.objectStore('meta');
  const hi = await req(meta.get('highestT'));
  let t = maxT(KINDS.flatMap((k) => state[k] || []));
  if (capClock) t = Math.min(t, Date.now());
  if (t > (hi ? hi.value : 0)) meta.put({ key: 'highestT', value: t });
  await done(tx);
  if (changed) emit('merge');
}

// Drawings: local blobs, uploaded once, never deleted remotely in v1.
export async function putDrawing(blob, uploaded = false) {
  const id = crypto.randomUUID();
  const tx = db.transaction('drawings', 'readwrite');
  tx.objectStore('drawings').put({ id, blob, bytes: blob.size, uploaded });
  await done(tx);
  return id;
}

export async function putRemoteDrawing(id, blob) {
  const tx = db.transaction('drawings', 'readwrite');
  tx.objectStore('drawings').put({ id, blob, bytes: blob.size, uploaded: true });
  await done(tx);
}

export async function getDrawing(id) {
  return req(db.transaction('drawings').objectStore('drawings').get(id));
}

export async function pendingDrawings() {
  const used = new Set((await list('blocks')).filter((b) => b.drawingId).map((b) => b.drawingId));
  return (await all('drawings')).filter((d) => !d.uploaded && used.has(d.id));
}

export async function markDrawingUploaded(id) {
  const tx = db.transaction('drawings', 'readwrite');
  const s = tx.objectStore('drawings');
  const d = await req(s.get(id));
  if (d) s.put({ ...d, uploaded: true });
  await done(tx);
}

// Restore inserts only ids that do not exist locally, and counts as a local change so it syncs.
export async function restore(validated) {
  const add = additiveRestore(await snapshot(), validated);
  for (const d of validated.drawings) {
    if (!(await getDrawing(d.id))) {
      const bytes = Uint8Array.from(atob(d.webp), (c) => c.charCodeAt(0));
      const tx = db.transaction('drawings', 'readwrite');
      tx.objectStore('drawings').put({ id: d.id, blob: new Blob([bytes], { type: 'image/webp' }), bytes: bytes.length, uploaded: false });
      await done(tx);
    }
  }
  await mergeIn(add, { capClock: true });
  await setMeta('mutationGen', (await getMeta('mutationGen', 0)) + 1);
  emit('restore');
  return { books: add.books.length, blocks: add.blocks.length, sessions: add.sessions.length };
}

export async function status() {
  const [mutationGen, syncedThroughGen, lastSyncOk] = await Promise.all([
    getMeta('mutationGen', 0), getMeta('syncedThroughGen', 0), getMeta('lastSyncOk', null),
  ]);
  return { mutationGen, syncedThroughGen, lastSyncOk, pending: mutationGen - syncedThroughGen };
}

export async function log(op, ok, code = '') {
  const entries = await getMeta('syncLog', []);
  entries.unshift({ time: Date.now(), op, ok, code: String(code).slice(0, 80) });
  await setMeta('syncLog', entries.slice(0, 50));
}
