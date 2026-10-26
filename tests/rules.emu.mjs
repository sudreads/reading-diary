// Firestore rules tests. Run with `npm run test:rules` (starts the emulator; needs Java 21).
// Every allow path in firestore.rules has at least one matching deny test.
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, deleteDoc, updateDoc, writeBatch, serverTimestamp, collection, collectionGroup,
  query, where, orderBy, limit, getDocs,
} from 'firebase/firestore';

let env;
const W = 'OL123W';

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-reading-diary',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

function claim(fs, uid, handle) {
  const b = writeBatch(fs);
  b.set(doc(fs, 'handles', handle), { uid, createdAt: serverTimestamp() });
  b.set(doc(fs, 'users', uid), { handle, createdAt: serverTimestamp() });
  return b.commit();
}

const review = (uid, handle, extra = {}) => ({
  workId: W, uid, handle, rating: 4, text: 'Great book', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra,
});

async function seedUser(uid, handle) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, 'handles', handle), { uid, createdAt: new Date() });
    await setDoc(doc(fs, 'users', uid), { handle, createdAt: new Date() });
  });
}
// Seeded a minute in the past so the 10-second edit throttle doesn't apply.
async function seedReview(uid, handle, workId = W) {
  const past = new Date(Date.now() - 60_000);
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'works', workId, 'reviews', uid), { workId, uid, handle, rating: 5, text: 'x', createdAt: past, updatedAt: past });
  });
}

// ---------- handles + users ----------

test('claiming a handle in one batch works', async () => {
  await assertSucceeds(claim(db('alice'), 'alice', 'alice_reads'));
});

test('a taken handle cannot be claimed by someone else', async () => {
  await seedUser('alice', 'alice_reads');
  await assertFails(claim(db('bob'), 'bob', 'alice_reads'));
});

test('one account can never claim a second handle', async () => {
  await seedUser('alice', 'alice_reads');
  await assertFails(claim(db('alice'), 'alice', 'alice_two'));
});

test('invalid handles are refused', async () => {
  for (const h of ['AB', 'Has Space', 'UPPER', 'x'.repeat(21), 'bad!']) await assertFails(claim(db('alice'), 'alice', h));
});

test('user doc or handle doc alone is refused', async () => {
  const fs = db('alice');
  await assertFails(setDoc(doc(fs, 'users', 'alice'), { handle: 'alice_reads', createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(fs, 'handles', 'alice_reads'), { uid: 'alice', createdAt: serverTimestamp() }));
});

test('claiming for another uid is refused', async () => {
  await assertFails(claim(db('mallory'), 'alice', 'alice_reads'));
});

test('users and handles cannot be updated or deleted', async () => {
  await seedUser('alice', 'alice_reads');
  const fs = db('alice');
  await assertFails(deleteDoc(doc(fs, 'users', 'alice')));
  await assertFails(deleteDoc(doc(fs, 'handles', 'alice_reads')));
  await assertFails(updateDoc(doc(fs, 'users', 'alice'), { handle: 'other' }));
  await assertFails(updateDoc(doc(fs, 'handles', 'alice_reads'), { uid: 'bob' }));
});

test('users: own doc readable, others not; handles: get yes, list no', async () => {
  await seedUser('alice', 'alice_reads');
  await assertSucceeds(getDoc(doc(db('alice'), 'users', 'alice')));
  await assertFails(getDoc(doc(db('bob'), 'users', 'alice')));
  await assertSucceeds(getDoc(doc(db('bob'), 'handles', 'alice_reads')));
  await assertFails(getDocs(query(collection(db('bob'), 'handles'), limit(10))));
});

test('signed-out visitors can read nothing', async () => {
  await seedUser('alice', 'alice_reads');
  await seedReview('alice', 'alice_reads');
  await assertFails(getDoc(doc(db(null), 'handles', 'alice_reads')));
  await assertFails(getDoc(doc(db(null), 'works', W, 'reviews', 'alice')));
  await assertFails(getDocs(query(collection(db(null), 'works', W, 'reviews'), limit(10))));
});

// ---------- reviews ----------

test('posting your own valid review works', async () => {
  await seedUser('alice', 'alice_reads');
  await assertSucceeds(setDoc(doc(db('alice'), 'works', W, 'reviews', 'alice'), review('alice', 'alice_reads')));
});

test('posting as someone else, or under a fake handle, is refused', async () => {
  await seedUser('alice', 'alice_reads');
  await seedUser('bob', 'bob_b');
  await assertFails(setDoc(doc(db('bob'), 'works', W, 'reviews', 'alice'), review('alice', 'alice_reads')));
  await assertFails(setDoc(doc(db('bob'), 'works', W, 'reviews', 'bob'), review('bob', 'alice_reads')));
  await assertFails(setDoc(doc(db('bob'), 'works', W, 'reviews', 'bob'), review('alice', 'bob_b')));
});

test('a review needs a handle first', async () => {
  await assertFails(setDoc(doc(db('carol'), 'works', W, 'reviews', 'carol'), review('carol', 'carol')));
});

test('bad review bodies are refused', async () => {
  await seedUser('alice', 'alice_reads');
  const ref = doc(db('alice'), 'works', W, 'reviews', 'alice');
  for (const bad of [{ rating: 6 }, { rating: 0 }, { rating: 3.5 }, { rating: '5' }, { text: 'x'.repeat(2001) }, { text: 7 },
    { extra: true }, { createdAt: new Date() }, { updatedAt: new Date() }, { workId: 'OL999W' }]) {
    await assertFails(setDoc(ref, review('alice', 'alice_reads', bad)));
  }
  const missing = review('alice', 'alice_reads');
  delete missing.text;
  await assertFails(setDoc(ref, missing));
});

test('reviews under a malformed work id are refused', async () => {
  await seedUser('alice', 'alice_reads');
  await assertFails(setDoc(doc(db('alice'), 'works', 'not-a-work', 'reviews', 'alice'), review('alice', 'alice_reads', { workId: 'not-a-work' })));
});

test('edits are throttled to one per 10 seconds', async () => {
  await seedUser('alice', 'alice_reads');
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'works', W, 'reviews', 'alice'),
    { workId: W, uid: 'alice', handle: 'alice_reads', rating: 5, text: 'x', createdAt: new Date(), updatedAt: new Date() }));
  await assertFails(updateDoc(doc(db('alice'), 'works', W, 'reviews', 'alice'), { rating: 2, updatedAt: serverTimestamp() }));
});

test('owner can edit rating and text only', async () => {
  await seedUser('alice', 'alice_reads');
  await seedReview('alice', 'alice_reads');
  const ref = doc(db('alice'), 'works', W, 'reviews', 'alice');
  await assertSucceeds(updateDoc(ref, { rating: 2, text: 'Changed my mind', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { handle: 'someone_else', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { workId: 'OL5W', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { rating: 9, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { rating: 3 })); // updatedAt must be the server time
});

test('nobody else can edit or delete your review; admins can delete', async () => {
  await seedUser('alice', 'alice_reads');
  await seedReview('alice', 'alice_reads');
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'admins', 'yanai'), {}));
  await assertFails(updateDoc(doc(db('bob'), 'works', W, 'reviews', 'alice'), { rating: 1, updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(db('bob'), 'works', W, 'reviews', 'alice')));
  await assertSucceeds(deleteDoc(doc(db('yanai'), 'works', W, 'reviews', 'alice')));
  await seedReview('alice', 'alice_reads');
  await assertSucceeds(deleteDoc(doc(db('alice'), 'works', W, 'reviews', 'alice')));
});

test('listing a book\'s reviews needs a limit of at most 50', async () => {
  await seedUser('alice', 'alice_reads');
  await seedReview('alice', 'alice_reads');
  const col = collection(db('bob'), 'works', W, 'reviews');
  await assertSucceeds(getDocs(query(col, orderBy('createdAt', 'desc'), limit(50))));
  await assertFails(getDocs(query(col, limit(51))));
  await assertFails(getDocs(col));
});

// 2.0: Explore reads the latest reviews across books, in pages of at most 30.
test('collection-group review queries: pages of 30 allowed, bigger refused, signed-out refused', async () => {
  await seedUser('alice', 'alice_reads');
  await seedReview('alice', 'alice_reads');
  await seedReview('alice', 'alice_reads', 'OL777W');
  await assertSucceeds(getDocs(query(collectionGroup(db('bob'), 'reviews'), limit(30))));
  await assertFails(getDocs(query(collectionGroup(db('bob'), 'reviews'), limit(31))));
  await assertFails(getDocs(query(collectionGroup(db('bob'), 'reviews'))));
  await assertFails(getDocs(query(collectionGroup(db(null), 'reviews'), limit(10))));
});

// ---------- reports + admins ----------

const report = (uid, extra = {}) => ({ workId: W, reviewerUid: 'alice', uid, reason: 'spam', createdAt: serverTimestamp(), ...extra });

test('reporting a real review works once per reporter', async () => {
  await seedUser('alice', 'alice_reads');
  await seedReview('alice', 'alice_reads');
  const ref = doc(db('bob'), 'reports', `${W}_alice_bob`);
  await assertSucceeds(setDoc(ref, report('bob')));
  await assertFails(setDoc(ref, report('bob', { reason: 'mean' }))); // no updates
});

test('bad reports are refused', async () => {
  await seedUser('alice', 'alice_reads');
  await seedReview('alice', 'alice_reads');
  const fs = db('bob');
  await assertFails(setDoc(doc(fs, 'reports', `${W}_alice_bob`), report('bob', { reason: 'boring' })));
  await assertFails(setDoc(doc(fs, 'reports', `${W}_alice_bob`), report('mallory')));
  await assertFails(setDoc(doc(fs, 'reports', `${W}_alice_xyz`), report('bob')));
  await assertFails(setDoc(doc(fs, 'reports', `OL9W_alice_bob`), report('bob', { workId: 'OL9W' }))); // no such review
  await assertFails(setDoc(doc(fs, 'reports', `${W}_alice_bob`), report('bob', { extra: 1 })));
});

test('reports: reporter and admin can read; others cannot; only admin lists all', async () => {
  await seedUser('alice', 'alice_reads');
  await seedReview('alice', 'alice_reads');
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'admins', 'yanai'), {});
    await setDoc(doc(ctx.firestore(), 'reports', `${W}_alice_bob`), { workId: W, reviewerUid: 'alice', uid: 'bob', reason: 'spam', createdAt: new Date() });
  });
  await assertSucceeds(getDoc(doc(db('bob'), 'reports', `${W}_alice_bob`)));
  await assertFails(getDoc(doc(db('carol'), 'reports', `${W}_alice_bob`)));
  await assertSucceeds(getDocs(query(collection(db('bob'), 'reports'), where('uid', '==', 'bob'))));
  await assertFails(getDocs(query(collection(db('carol'), 'reports'), limit(10))));
  await assertSucceeds(getDocs(query(collection(db('yanai'), 'reports'), limit(50))));
  await assertSucceeds(deleteDoc(doc(db('bob'), 'reports', `${W}_alice_bob`)));
});

test('admins: you can see only your own admin doc, and nobody can make themselves admin', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'admins', 'yanai'), {}));
  await assertSucceeds(getDoc(doc(db('yanai'), 'admins', 'yanai')));
  await assertFails(getDoc(doc(db('bob'), 'admins', 'yanai')));
  await assertFails(setDoc(doc(db('bob'), 'admins', 'bob'), {}));
});
