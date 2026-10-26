import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDocs, fromDoc, pushDirty, pullChanges, cloudCovers, docTooBig } from '../js/cloud.js';
import { mergeRecord } from '../js/merge.js';
import { cmpRev } from '../js/rev.js';

// A fake Firestore that enforces the same "strictly newer revision" rule as firestore.rules.
function fakeCloud() {
  const docs = new Map();
  let clock = 1000;
  const newer = (n, o) => n.t > o.t || (n.t === o.t && n.d > o.d);
  const put = (doc) => {
    const old = docs.get(doc.rid);
    if (old && !newer(doc, old)) { const e = new Error('permission-denied'); e.code = 'permission-denied'; throw e; }
    docs.set(doc.rid, { ...doc, uMs: ++clock });
  };
  return {
    docs, pageSize: 2,
    async writeBatch(list) {
      for (const d of list) { const old = docs.get(d.rid); if (old && !newer(d, old)) throw new Error('permission-denied'); }
      list.forEach(put);
    },
    async writeOne(d) { put(d); },
    async getOne(rid) { return docs.get(rid) || null; },
    async page(since, after) {
      const all = [...docs.values()].filter((d) => d.uMs > since).sort((a, b) => a.uMs - b.uMs);
      const start = after ? all.findIndex((d) => d === after) + 1 : 0;
      const slice = all.slice(start, start + this.pageSize);
      return { docs: slice, last: slice.at(-1) || null };
    },
  };
}

// A fake local store: records by kind, dirty map, cursor.
function fakeLocal() {
  const data = { books: new Map(), blocks: new Map(), sessions: new Map() };
  const dirty = new Map();
  let cursor = 0;
  return {
    data, dirtyMap: dirty,
    write(kind, rec, which = 'both') {
      const prev = data[kind].get(rec.id) || {};
      data[kind].set(rec.id, { ...prev, ...rec });
      for (const d of toDocs(kind, data[kind].get(rec.id), which)) dirty.set(d.rid, d.t);
    },
    async dirty() { return Object.fromEntries(dirty); },
    async docFor(rid) {
      const [kind, ...rest] = rid.split('_');
      const id = rest.join('_');
      const local = kind === 'rank' ? data.blocks.get(id) : data[kind]?.get(id);
      if (!local) return null;
      return toDocs(kind === 'rank' ? 'blocks' : kind, local, kind === 'rank' ? 'rank' : 'content')[0] || null;
    },
    async ack(rid, t) { if (dirty.get(rid) === t) dirty.delete(rid); },
    async mergeRemote(docs) {
      for (const doc of docs) { const [kind, rec] = fromDoc(doc); data[kind].set(rec.id, mergeRecord(data[kind].get(rec.id), rec)); }
    },
    async getCursor() { return cursor; },
    async setCursor(c) { cursor = c; },
  };
}

const book = (id, t, extra = {}) => ({ id, title: 'Rich Dad Poor Dad', status: 'reading', rev: { t, d: 'phone' }, ...extra });

test('toDocs/fromDoc: a block splits into content + rank and comes back whole', () => {
  const block = { id: 'b1', bookId: 'k', type: 'page', text: 'hi', rank: 'm', rev: { t: 5, d: 'a' }, rankRev: { t: 7, d: 'a' }, deleted: false };
  const docs = toDocs('blocks', block);
  assert.deepEqual(docs.map((d) => d.rid), ['blocks_b1', 'rank_b1']);
  assert.equal(docs[0].data.rank, undefined);
  let merged;
  for (const d of docs) { const [kind, rec] = fromDoc(d); assert.equal(kind, 'blocks'); merged = mergeRecord(merged, rec); }
  assert.equal(merged.text, 'hi');
  assert.equal(merged.rank, 'm');
  assert.equal(cmpRev(merged.rankRev, block.rankRev), 0);
  assert.equal(cmpRev(merged.rev, block.rev), 0);
});

test('push sends dirty records and clears them; nothing left dirty', async () => {
  const cloud = fakeCloud(), local = fakeLocal();
  local.write('books', book('b1', 10));
  local.write('books', book('b2', 11));
  const res = await pushDirty({ store: local, api: cloud });
  assert.equal(res.sent, 2);
  assert.equal(local.dirtyMap.size, 0);
  assert.equal(cloud.docs.get('books_b1').data.title, 'Rich Dad Poor Dad');
});

test('an edit made while a push is in flight stays dirty', async () => {
  const cloud = fakeCloud(), local = fakeLocal();
  local.write('books', book('b1', 10));
  const real = cloud.writeBatch.bind(cloud);
  cloud.writeBatch = async (list) => { await real(list); local.write('books', book('b1', 12, { title: 'Edited' })); };
  await pushDirty({ store: local, api: cloud });
  assert.equal(local.dirtyMap.get('books_b1'), 12);
  cloud.writeBatch = real;
  await pushDirty({ store: local, api: cloud });
  assert.equal(cloud.docs.get('books_b1').data.title, 'Edited');
  assert.equal(local.dirtyMap.size, 0);
});

test('a write refused because the cloud is newer adopts the cloud version instead of looping', async () => {
  const cloud = fakeCloud(), local = fakeLocal();
  await cloud.writeOne(toDocs('books', book('b1', 50, { title: 'From the other phone' }))[0]);
  local.write('books', book('b1', 20, { title: 'Old offline edit' }));
  local.write('books', book('b2', 21));
  await pushDirty({ store: local, api: cloud });
  assert.equal(local.data.books.get('b1').title, 'From the other phone');
  assert.equal(local.dirtyMap.size, 0);
  assert.ok(cloud.docs.get('books_b2')); // the unrelated record in the same failed batch still went up
});

test('a refusal that is not about revisions stays dirty (no data loss, retried later)', async () => {
  const cloud = fakeCloud(), local = fakeLocal();
  local.write('books', book('b1', 10));
  cloud.writeBatch = async () => { throw new Error('offline'); };
  cloud.writeOne = async () => { throw new Error('offline'); };
  const res = await pushDirty({ store: local, api: cloud });
  assert.equal(res.failed, 1);  // network trouble: quiet retry, not "couldn't be saved"
  assert.equal(res.skipped, 0);
  assert.equal(local.dirtyMap.size, 1);
});

test('a rules refusal (not a revision clash) is reported as skipped and stays dirty', async () => {
  const cloud = fakeCloud(), local = fakeLocal();
  local.write('books', book('b1', 10));
  const denied = () => { const e = new Error('denied'); e.code = 'permission-denied'; throw e; };
  cloud.writeBatch = async () => denied();
  cloud.writeOne = async () => denied();
  const res = await pushDirty({ store: local, api: cloud });
  assert.equal(res.skipped, 1);
  assert.equal(local.dirtyMap.size, 1);
});

test('pull pages through changes, merges them and advances the cursor', async () => {
  const cloud = fakeCloud(), phoneA = fakeLocal(), phoneB = fakeLocal();
  for (let i = 0; i < 5; i++) phoneA.write('books', book(`b${i}`, 10 + i));
  await pushDirty({ store: phoneA, api: cloud });
  const read = await pullChanges({ store: phoneB, api: cloud, overlapMs: 0 });
  assert.equal(read, 5);
  assert.equal(phoneB.data.books.size, 5);
  assert.ok((await phoneB.getCursor()) > 0);
  assert.equal(await pullChanges({ store: phoneB, api: cloud, overlapMs: 0 }), 0); // nothing new
});

test('two phones editing offline converge on the newest version after push + pull', async () => {
  const cloud = fakeCloud(), a = fakeLocal(), b = fakeLocal();
  a.write('books', book('x', 10, { title: 'A wrote this' }));
  b.write('books', book('x', 20, { title: 'B wrote this later' }));
  await pushDirty({ store: a, api: cloud });
  await pushDirty({ store: b, api: cloud });
  await pullChanges({ store: a, api: cloud, overlapMs: 0 });
  assert.equal(a.data.books.get('x').title, 'B wrote this later');
  assert.equal(b.data.books.get('x').title, 'B wrote this later');
});

test('reorder on one phone and text edit on another both survive', async () => {
  const cloud = fakeCloud(), a = fakeLocal(), b = fakeLocal();
  const blk = { id: 'p', bookId: 'k', type: 'page', text: 'v1', rank: 'm', rev: { t: 5, d: 'a' }, rankRev: { t: 5, d: 'a' } };
  a.write('blocks', blk);
  await pushDirty({ store: a, api: cloud });
  await pullChanges({ store: b, api: cloud, overlapMs: 0 });
  a.write('blocks', { id: 'p', text: 'v2', rev: { t: 9, d: 'a' } }, 'content');
  b.write('blocks', { id: 'p', rank: 'c', rankRev: { t: 8, d: 'b' } }, 'rank');
  await pushDirty({ store: a, api: cloud });
  await pushDirty({ store: b, api: cloud });
  await pullChanges({ store: a, api: cloud, overlapMs: 0 });
  await pullChanges({ store: b, api: cloud, overlapMs: 0 });
  for (const s of [a, b]) {
    assert.equal(s.data.blocks.get('p').text, 'v2');
    assert.equal(s.data.blocks.get('p').rank, 'c');
  }
});

test('cloudCovers proves the backup and names what is missing or older', () => {
  const local = toDocs('books', book('b1', 10));
  assert.equal(cloudCovers(local, new Map([['books_b1', { ...local[0] }]])), '');
  assert.match(cloudCovers(local, new Map()), /isn't in your account/);
  assert.match(cloudCovers(local, new Map([['books_b1', { ...local[0], t: 9 }]])), /older/);
});

test('oversized records are held back instead of failing the whole batch', () => {
  assert.equal(docTooBig(toDocs('books', book('b1', 1))[0]), false);
  assert.equal(docTooBig(toDocs('blocks', { id: 'x', text: 'x'.repeat(60000), rev: { t: 1, d: 'a' } })[0]), true);
});
