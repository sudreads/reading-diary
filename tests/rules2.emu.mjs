// 2.0 Firestore rules: private records, catalog, canonical reviews, friends, activity.
// Run with `npm run test:rules` (emulator, Java 21). Allow AND deny for every path.
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, deleteDoc, updateDoc, writeBatch, serverTimestamp, collection, query, where, limit, getDocs,
} from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-reading-diary',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const admin = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));
async function seedUser(uid, handle) {
  await admin(async (fs) => {
    await setDoc(doc(fs, 'handles', handle), { uid, createdAt: new Date() });
    await setDoc(doc(fs, 'users', uid), { handle, createdAt: new Date() });
  });
}

// ---------- private records ----------

const ID = '0b9a6c1e-3f4d-4a5b-8c7d-9e0f1a2b3c4d';
const rec = (extra = {}) => ({ kind: 'books', id: ID, data: { title: 'Rich Dad Poor Dad', status: 'reading' }, t: 1000, d: 'dev-a', deleted: false, u: serverTimestamp(), ...extra });

test('records: owner can create and read; nobody else can read or write', async () => {
  const ref = (uid, owner = 'alice') => doc(db(uid), 'users', owner, 'records', `books_${ID}`);
  await assertSucceeds(setDoc(ref('alice'), rec()));
  await assertSucceeds(getDoc(ref('alice')));
  await assertSucceeds(getDocs(query(collection(db('alice'), 'users', 'alice', 'records'), where('u', '>', new Date(0)), limit(300))));
  await assertFails(getDoc(ref('bob')));
  await assertFails(getDocs(collection(db('bob'), 'users', 'alice', 'records')));
  await assertFails(setDoc(doc(db('bob'), 'users', 'alice', 'records', `books_${ID}`), rec()));
  await assertFails(getDoc(ref(null)));
});

test('records: only strictly newer revisions may overwrite; never deleted', async () => {
  const ref = doc(db('alice'), 'users', 'alice', 'records', `books_${ID}`);
  await assertSucceeds(setDoc(ref, rec({ t: 1000, d: 'dev-a' })));
  await assertFails(setDoc(ref, rec({ t: 999, d: 'dev-z' })));          // older
  await assertFails(setDoc(ref, rec({ t: 1000, d: 'dev-a' })));         // same
  await assertSucceeds(setDoc(ref, rec({ t: 1000, d: 'dev-b' })));      // same t, higher device
  await assertSucceeds(setDoc(ref, rec({ t: 2000, d: 'dev-a', deleted: true }))); // tombstone
  await assertFails(deleteDoc(ref));
});

test('records: malformed ids, kinds, oversized text and client timestamps are refused', async () => {
  const fs = db('alice');
  await assertFails(setDoc(doc(fs, 'users', 'alice', 'records', 'books_not-a-uuid'), rec({ id: 'not-a-uuid' })));
  await assertFails(setDoc(doc(fs, 'users', 'alice', 'records', `secrets_${ID}`), rec({ kind: 'secrets' })));
  await assertFails(setDoc(doc(fs, 'users', 'alice', 'records', `blocks_${ID}`), rec()));                // id/kind mismatch
  await assertFails(setDoc(doc(fs, 'users', 'alice', 'records', `books_${ID}`), rec({ u: new Date() })));
  await assertFails(setDoc(doc(fs, 'users', 'alice', 'records', `books_${ID}`), rec({ data: { text: 'x'.repeat(20001) } })));
  await assertFails(setDoc(doc(fs, 'users', 'alice', 'records', `books_${ID}`), rec({ extra: 1 })));
  await assertFails(setDoc(doc(fs, 'users', 'alice', 'records', `books_${ID}`), rec({ t: 1.5 })));
  const many = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`k${i}`, i]));
  await assertFails(setDoc(doc(fs, 'users', 'alice', 'records', `books_${ID}`), rec({ data: many })));
});

// ---------- catalog ----------

const book = (extra = {}) => ({ key: 'isbn:9781612680194', title: 'Rich Dad Poor Dad', titleLower: 'rich dad poor dad', author: 'Robert T. Kiyosaki', isbn13: '9781612680194', pages: 336, coverUrl: 'https://books.google.com/books/content?id=x', createdBy: 'alice', createdAt: serverTimestamp(), ...extra });

test('catalog: valid entries can be added once; immutable; signed-in readable', async () => {
  const ref = doc(db('alice'), 'catalog', 'isbn:9781612680194');
  await assertSucceeds(setDoc(ref, book()));
  await assertSucceeds(getDoc(doc(db('bob'), 'catalog', 'isbn:9781612680194')));
  await assertFails(updateDoc(ref, { title: 'Something else' }));
  await assertFails(setDoc(doc(db('bob'), 'catalog', 'isbn:9781612680194'), book({ createdBy: 'bob' })));
  await assertFails(deleteDoc(ref));
  await assertFails(getDoc(doc(db(null), 'catalog', 'isbn:9781612680194')));
});

test('catalog: bad keys, forged creators, hostile covers and wrong lowercase are refused', async () => {
  const fs = db('alice');
  await assertFails(setDoc(doc(fs, 'catalog', 'isbn:123'), book({ key: 'isbn:123' })));
  await assertFails(setDoc(doc(fs, 'catalog', 'evil'), book({ key: 'evil' })));
  await assertFails(setDoc(doc(fs, 'catalog', 'isbn:9781612680194'), book({ createdBy: 'bob' })));
  await assertFails(setDoc(doc(fs, 'catalog', 'isbn:9781612680194'), book({ coverUrl: 'https://evil.example/x.jpg' })));
  await assertFails(setDoc(doc(fs, 'catalog', 'isbn:9781612680194'), book({ coverUrl: 'javascript:alert(1)' })));
  await assertFails(setDoc(doc(fs, 'catalog', 'isbn:9781612680194'), book({ titleLower: 'RICH' })));
  await assertFails(setDoc(doc(fs, 'catalog', 'isbn:9781612680194'), book({ title: '' , titleLower: '' })));
  // hand-made books can't enter the shared catalog
  await assertFails(setDoc(doc(fs, 'catalog', 'c:0b9a6c1e-3f4d-4a5b-8c7d-9e0f1a2b3c4d'), book({ key: 'c:0b9a6c1e-3f4d-4a5b-8c7d-9e0f1a2b3c4d', isbn13: '', coverUrl: '' })));
});

test('catalog: prefix search pages of 20 allowed, bigger refused', async () => {
  const col = collection(db('bob'), 'catalog');
  await assertSucceeds(getDocs(query(col, where('titleLower', '>=', 'rich'), where('titleLower', '<', 'rich'), limit(20))));
  await assertFails(getDocs(query(col, limit(21))));
});

// ---------- 2.0 reviews ----------

const KEY = 'isbn:9781612680194';
const review = (uid, handle, extra = {}) => ({ bookKey: KEY, uid, handle, rating: 4, text: 'Great', title: 'Rich Dad Poor Dad', author: 'Robert T. Kiyosaki', coverUrl: 'https://books.google.com/books/content?id=x', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra });
const seedCatalog = () => admin((fs) => setDoc(doc(fs, 'catalog', KEY), { ...book(), createdAt: new Date() }));

test('reviews: valid review on a catalogued book works; needs the catalog entry', async () => {
  await seedUser('alice', 'alice_reads');
  const ref = doc(db('alice'), 'books', KEY, 'reviews', 'alice');
  await assertFails(setDoc(ref, review('alice', 'alice_reads')));        // no catalog entry yet
  await seedCatalog();
  await assertSucceeds(setDoc(ref, review('alice', 'alice_reads')));
});

test('reviews: impersonation, forged hints and bad bodies are refused', async () => {
  await seedUser('alice', 'alice_reads');
  await seedUser('bob', 'bob_b');
  await seedCatalog();
  await assertFails(setDoc(doc(db('bob'), 'books', KEY, 'reviews', 'alice'), review('alice', 'alice_reads')));
  await assertFails(setDoc(doc(db('bob'), 'books', KEY, 'reviews', 'bob'), review('bob', 'alice_reads')));
  const ref = doc(db('alice'), 'books', KEY, 'reviews', 'alice');
  for (const bad of [{ rating: 6 }, { rating: 2.5 }, { text: 'x'.repeat(2001) }, { coverUrl: 'https://evil.example/c.jpg' }, { bookKey: 'isbn:9780000000002' }, { extra: 1 }, { createdAt: new Date() },
    { title: 'A completely different book' }, { author: 'Someone Else' }, { coverUrl: 'https://covers.openlibrary.org/b/id/999-M.jpg' }]) {
    await assertFails(setDoc(ref, review('alice', 'alice_reads', bad)));
  }
});

// ---------- friends ----------

async function request(fromUid, fromHandle, toUid, toHandle) {
  return setDoc(doc(db(fromUid), 'friendRequests', `${fromUid}_${toUid}`), { from: fromUid, to: toUid, fromHandle, toHandle, createdAt: serverTimestamp() });
}
function acceptBatch(meUid, fromUid, meHandle, fromHandle) {
  const fs = db(meUid);
  const b = writeBatch(fs);
  b.delete(doc(fs, 'friendRequests', `${fromUid}_${meUid}`));
  b.set(doc(fs, 'friends', meUid, 'list', fromUid), { handle: fromHandle, since: serverTimestamp() });
  b.set(doc(fs, 'friends', fromUid, 'list', meUid), { handle: meHandle, since: serverTimestamp() });
  return b.commit();
}

test('friend request: valid request works; impersonation and wrong targets are refused', async () => {
  await seedUser('alice', 'alice_reads');
  await seedUser('bob', 'bob_b');
  await seedUser('carol', 'carol_c');
  await assertSucceeds(request('alice', 'alice_reads', 'bob', 'bob_b'));
  await assertFails(request('carol', 'alice_reads', 'bob', 'bob_b'));          // fake fromHandle
  await assertFails(request('carol', 'carol_c', 'alice', 'bob_b'));            // handle doesn't belong to target
  await assertFails(request('carol', 'carol_c', 'carol', 'carol_c'));          // self
  await assertFails(request('bob', 'bob_b', 'alice', 'alice_reads'));          // crossed: alice already asked bob
  await assertFails(setDoc(doc(db('carol'), 'friendRequests', 'alice_bob'), { from: 'alice', to: 'bob', fromHandle: 'alice_reads', toHandle: 'bob_b', createdAt: serverTimestamp() }));
});

test('friend request: only sender and receiver can see it; sender cancels, receiver declines; no edits', async () => {
  await seedUser('alice', 'alice_reads');
  await seedUser('bob', 'bob_b');
  await request('alice', 'alice_reads', 'bob', 'bob_b');
  await assertSucceeds(getDoc(doc(db('bob'), 'friendRequests', 'alice_bob')));
  await assertFails(getDoc(doc(db('carol'), 'friendRequests', 'alice_bob')));
  await assertSucceeds(getDocs(query(collection(db('bob'), 'friendRequests'), where('to', '==', 'bob'))));
  await assertFails(getDocs(collection(db('carol'), 'friendRequests')));
  await assertFails(updateDoc(doc(db('bob'), 'friendRequests', 'alice_bob'), { toHandle: 'x' }));
  await assertFails(deleteDoc(doc(db('carol'), 'friendRequests', 'alice_bob')));
  await assertSucceeds(deleteDoc(doc(db('bob'), 'friendRequests', 'alice_bob')));   // decline
  await request('alice', 'alice_reads', 'bob', 'bob_b');
  await assertSucceeds(deleteDoc(doc(db('alice'), 'friendRequests', 'alice_bob'))); // cancel
});

test('accepting creates both edges in one batch and consumes the request; forging friendship fails', async () => {
  await seedUser('alice', 'alice_reads');
  await seedUser('bob', 'bob_b');
  await seedUser('carol', 'carol_c');
  await assertFails(acceptBatch('bob', 'alice', 'bob_b', 'alice_reads'));     // no request yet
  await request('alice', 'alice_reads', 'bob', 'bob_b');
  await assertFails(acceptBatch('alice', 'bob', 'alice_reads', 'bob_b'));     // sender can't accept own request
  await assertFails(acceptBatch('carol', 'alice', 'carol_c', 'alice_reads')); // not the receiver
  const fs = db('bob');
  const half = writeBatch(fs);                                                 // one edge only
  half.delete(doc(fs, 'friendRequests', 'alice_bob'));
  half.set(doc(fs, 'friends', 'bob', 'list', 'alice'), { handle: 'alice_reads', since: serverTimestamp() });
  await assertFails(half.commit());
  await assertSucceeds(acceptBatch('bob', 'alice', 'bob_b', 'alice_reads'));
  await assertSucceeds(getDocs(collection(db('alice'), 'friends', 'alice', 'list')));
  await assertFails(getDocs(collection(db('carol'), 'friends', 'alice', 'list')));
});

test('unfriending removes both edges together; one-sided removal is refused', async () => {
  await seedUser('alice', 'alice_reads');
  await seedUser('bob', 'bob_b');
  await request('alice', 'alice_reads', 'bob', 'bob_b');
  await acceptBatch('bob', 'alice', 'bob_b', 'alice_reads');
  await assertFails(deleteDoc(doc(db('alice'), 'friends', 'alice', 'list', 'bob')));
  await assertFails(deleteDoc(doc(db('carol'), 'friends', 'alice', 'list', 'bob')));
  const fs = db('alice');
  const b = writeBatch(fs);
  b.delete(doc(fs, 'friends', 'alice', 'list', 'bob'));
  b.delete(doc(fs, 'friends', 'bob', 'list', 'alice'));
  await assertSucceeds(b.commit());
});

// ---------- activity ----------

const activity = (handle, extra = {}) => ({ handle, currentBook: { key: KEY, title: 'Rich Dad Poor Dad', coverUrl: '' }, streak: 5, finishedCount: 2, lastFinished: null, updatedAt: serverTimestamp(), ...extra });

test('activity: owner writes; only mutual friends read; never strangers', async () => {
  await seedUser('alice', 'alice_reads');
  await seedUser('bob', 'bob_b');
  await seedUser('carol', 'carol_c');
  await assertSucceeds(setDoc(doc(db('alice'), 'activity', 'alice'), activity('alice_reads')));
  await assertFails(getDoc(doc(db('bob'), 'activity', 'alice')));
  await request('alice', 'alice_reads', 'bob', 'bob_b');
  await acceptBatch('bob', 'alice', 'bob_b', 'alice_reads');
  await assertSucceeds(getDoc(doc(db('bob'), 'activity', 'alice')));
  await assertFails(getDoc(doc(db('carol'), 'activity', 'alice')));
  await assertFails(getDocs(collection(db('bob'), 'activity')));
  // a lingering one-sided edge (planted directly) does not grant access
  await admin((fs) => setDoc(doc(fs, 'friends', 'carol', 'list', 'alice'), { handle: 'alice_reads', since: new Date() }));
  await assertFails(getDoc(doc(db('carol'), 'activity', 'alice')));
  // only the owner can take the card down
  await assertFails(deleteDoc(doc(db('bob'), 'activity', 'alice')));
  await assertSucceeds(deleteDoc(doc(db('alice'), 'activity', 'alice')));
});

test('activity: forged handles, other people\'s cards and bad fields are refused', async () => {
  await seedUser('alice', 'alice_reads');
  await assertFails(setDoc(doc(db('bob'), 'activity', 'alice'), activity('alice_reads')));
  const ref = doc(db('alice'), 'activity', 'alice');
  for (const bad of [{ handle: 'someone' }, { streak: -1 }, { streak: 1.5 }, { currentBook: { key: KEY, title: 'x', coverUrl: 'https://evil.example/c' } },
    { lastFinished: { key: KEY, title: 'x', coverUrl: '', rating: 9 } }, { notebook: 'secret' }, { updatedAt: new Date() }]) {
    await assertFails(setDoc(ref, activity('alice_reads', bad)));
  }
  await assertSucceeds(setDoc(ref, activity('alice_reads', { lastFinished: { key: KEY, title: 'x', coverUrl: '', rating: 5 } })));
});
