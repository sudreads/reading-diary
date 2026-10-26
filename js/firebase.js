// The public layer: Firebase Auth (signed in with the Google token the app already has) and the
// Firestore reviews database. The SDK loads lazily, so the private diary never waits on it.

import { FIREBASE_CONFIG } from './config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
let sdk = null; // { app, auth, db, fa, fs }
const EMULATED = location.hostname === 'localhost' && new URLSearchParams(location.search).has('emu');
let loading = null;

export const isConfigured = () => !!FIREBASE_CONFIG;

// Memoised: two early callers must share one initializeApp, or the second one throws.
function load() {
  if (sdk) return Promise.resolve(sdk);
  if (!isConfigured()) return Promise.reject(new Error('firebase-not-configured'));
  loading ||= init().catch((e) => { loading = null; throw e; });
  return loading;
}

async function init() {
  const [{ initializeApp }, fa, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(FIREBASE_CONFIG);
  // No popup/redirect resolver: sign-in is a credential exchange, so no cross-site auth iframe.
  const auth = fa.initializeAuth(app, { persistence: [fa.indexedDBLocalPersistence] });
  // Memory cache only: nothing queued here can replay after sign-out or an account switch.
  const db = fs.initializeFirestore(app, { localCache: fs.memoryLocalCache() });
  // Local testing only (tools/dev_serve.py, localhost + ?emu): talk to the Firebase emulators.
  if (EMULATED) {
    fa.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    fs.connectFirestoreEmulator(db, '127.0.0.1', 8085);
  }
  await auth.authStateReady();
  sdk = { app, auth, db, fa, fs };
  return sdk;
}

export async function currentUser() {
  if (!isConfigured()) return null;
  const { auth } = await load();
  return auth.currentUser;
}

// Exchange the Google access token for a Firebase session (kept in IndexedDB by Firebase).
export async function signInWithGoogleToken(accessToken, email) {
  const { auth, fa } = await load();
  if (auth.currentUser && auth.currentUser.email === email) return auth.currentUser;
  const cred = fa.GoogleAuthProvider.credential(null, accessToken);
  const res = await fa.signInWithCredential(auth, cred);
  return res.user;
}

// Emulator-only test sign-in (the Auth emulator accepts a fake Google id token as JSON).
export async function emuSignIn(email) {
  if (!EMULATED) throw new Error('emulator only');
  const { auth, fa } = await load();
  const sub = email.replace(/[^a-z0-9]/gi, '').slice(0, 20);
  const res = await fa.signInWithCredential(auth, fa.GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true })));
  return res.user;
}

export async function signOut() {
  if (!sdk) return;
  await sdk.fa.signOut(sdk.auth);
}

// ----- profile -----

export async function myHandle(uid) {
  const { db, fs } = await load();
  const snap = await fs.getDoc(fs.doc(db, 'users', uid));
  return snap.exists() ? snap.data().handle : null;
}

export async function handleTaken(handle) {
  const { db, fs } = await load();
  return (await fs.getDoc(fs.doc(db, 'handles', handle))).exists();
}

export async function claimHandle(uid, handle) {
  const { db, fs } = await load();
  const b = fs.writeBatch(db);
  b.set(fs.doc(db, 'handles', handle), { uid, createdAt: fs.serverTimestamp() });
  b.set(fs.doc(db, 'users', uid), { handle, createdAt: fs.serverTimestamp() });
  await b.commit();
}

export async function isAdmin(uid) {
  const { db, fs } = await load();
  try { return (await fs.getDoc(fs.doc(db, 'admins', uid))).exists(); } catch { return false; }
}

// ----- private diary records (2.0) -----

const RECORD_PAGE = 300;
const recordRef = (fs, db, uid, rid) => fs.doc(db, 'users', uid, 'records', rid);
const toRecordDoc = (fs, d) => ({ kind: d.kind, id: d.id, data: d.data, t: d.t, d: d.d, deleted: d.deleted, u: fs.serverTimestamp() });
const fromSnap = (s) => { const x = s.data(); return { rid: s.id, kind: x.kind, id: x.id, data: x.data, t: x.t, d: x.d, deleted: x.deleted, uMs: x.u?.toMillis?.() || 0, snap: s }; };

// The injected api cloud.js expects, bound to one account.
export function recordsApi(uid) {
  return {
    pageSize: RECORD_PAGE,
    async writeBatch(docs) {
      const { db, fs } = await load();
      const b = fs.writeBatch(db);
      for (const d of docs) b.set(recordRef(fs, db, uid, d.rid), toRecordDoc(fs, d));
      await b.commit();
    },
    async writeOne(d) {
      const { db, fs } = await load();
      await fs.setDoc(recordRef(fs, db, uid, d.rid), toRecordDoc(fs, d));
    },
    async getOne(rid) {
      const { db, fs } = await load();
      const s = await fs.getDoc(recordRef(fs, db, uid, rid));
      return s.exists() ? fromSnap(s) : null;
    },
    async page(sinceMs, after) {
      const { db, fs } = await load();
      const parts = [fs.collection(db, 'users', uid, 'records'), fs.where('u', '>', fs.Timestamp.fromMillis(sinceMs)), fs.orderBy('u')];
      if (after) parts.push(fs.startAfter(after.snap));
      parts.push(fs.limit(RECORD_PAGE));
      const res = await fs.getDocs(fs.query(...parts));
      const docs = res.docs.map(fromSnap);
      return { docs, last: docs.at(-1) || null };
    },
  };
}

// ----- catalog (2.0) -----

// Registers a book in the shared catalog (existence + display hints). Immutable once there, so
// "already exists" is success. Needed before anyone can review it.
export async function ensureCatalog(uid, b) {
  const { db, fs } = await load();
  const ref = fs.doc(db, 'catalog', b.key);
  const have = await fs.getDoc(ref);
  if (have.exists()) return have.data();
  const title = String(b.title || '').slice(0, 300) || 'Untitled';
  try {
    await fs.setDoc(ref, {
      key: b.key, title, titleLower: title.toLowerCase(), author: String(b.author || '').slice(0, 300),
      isbn13: /^97[89]\d{10}$/.test(b.isbn13 || '') ? b.isbn13 : '', pages: Number.isInteger(b.pages) && b.pages >= 0 ? Math.min(b.pages, 100000) : 0,
      coverUrl: b.coverUrl || '', createdBy: uid, createdAt: fs.serverTimestamp(),
    });
  } catch (e) {
    if (!(await fs.getDoc(ref)).exists()) throw e; // someone else registered it a moment ago: fine
  }
  return (await fs.getDoc(ref)).data();
}

export async function catalogDoc(key) {
  const { db, fs } = await load();
  const s = await fs.getDoc(fs.doc(db, 'catalog', key));
  return s.exists() ? s.data() : null;
}

// Books readers added themselves, by title prefix.
export async function searchCommunity(q) {
  const { db, fs } = await load();
  const lo = q.trim().toLowerCase();
  const res = await fs.getDocs(fs.query(fs.collection(db, 'catalog'), fs.where('titleLower', '>=', lo), fs.where('titleLower', '<', `${lo}`), fs.limit(20)));
  return res.docs.map((s) => s.data()).filter((d) => d.key.startsWith('c:'))
    .map((d) => ({ key: d.key, source: 'community', title: d.title, author: d.author, year: '', pages: d.pages || 0, isbn13: d.isbn13 || '', coverUrl: d.coverUrl || '', description: '', categories: [], language: '' }));
}

export async function addCommunityBook(uid, { title, author, pages, isbn13 }) {
  const key = `c:${crypto.randomUUID()}`;
  await ensureCatalog(uid, { key, title, author, pages, isbn13, coverUrl: '' });
  return key;
}

// ----- reviews (2.0: books/{bookKey}/reviews/{uid}; 1.x works/{OL}/reviews stay readable) -----

const legacyWork = (key) => (key.startsWith('ol:') ? key.slice(3) : null);
const toReview2 = (snap, legacy) => {
  const d = snap.data();
  return { id: snap.id, uid: d.uid, handle: d.handle, rating: d.rating, text: d.text, bookKey: d.bookKey || (legacy ? `ol:${d.workId}` : ''),
    title: d.title || '', author: d.author || '', coverUrl: d.coverUrl || '', legacy,
    createdAt: d.createdAt?.toMillis?.() || 0, updatedAt: d.updatedAt?.toMillis?.() || 0, snap };
};

// Newest first; the new path wins over a 1.x review by the same person.
export async function reviewsFor(key, after = null) {
  const { db, fs } = await load();
  const page = (col) => {
    const parts = [col, fs.orderBy('createdAt', 'desc')];
    if (after?.[col.path]) parts.push(fs.startAfter(after[col.path]));
    parts.push(fs.limit(50));
    return fs.getDocs(fs.query(...parts));
  };
  const main = fs.collection(db, 'books', key, 'reviews');
  const old = legacyWork(key) ? fs.collection(db, 'works', legacyWork(key), 'reviews') : null;
  const [a, b] = await Promise.all([page(main), old && !after ? page(old) : null]);
  const byUid = new Map();
  for (const s of b?.docs || []) byUid.set(s.data().uid, toReview2(s, true));
  for (const s of a.docs) byUid.set(s.data().uid, toReview2(s, false));
  const list = [...byUid.values()].sort((x, y) => y.createdAt - x.createdAt);
  const cursor = { [main.path]: a.docs.at(-1) || null };
  return { list, cursor, more: a.docs.length === 50 };
}

export async function upsertReview2(uid, handle, book, rating, text) {
  const { db, fs } = await load();
  const cat = await ensureCatalog(uid, book); // the display fields must match the catalog entry
  const ref = fs.doc(db, 'books', book.key, 'reviews', uid);
  const existing = await fs.getDoc(ref);
  if (existing.exists()) {
    await fs.updateDoc(ref, { rating, text, updatedAt: fs.serverTimestamp() });
  } else {
    await fs.setDoc(ref, { bookKey: book.key, uid, handle, rating, text, title: cat.title, author: cat.author, coverUrl: cat.coverUrl,
      createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp() });
  }
}

// Removes the review at both homes (a 1.x review may still sit under works/).
export async function deleteReview2(key, uid) {
  const { db, fs } = await load();
  await fs.deleteDoc(fs.doc(db, 'books', key, 'reviews', uid));
  if (legacyWork(key)) await fs.deleteDoc(fs.doc(db, 'works', legacyWork(key), 'reviews', uid)).catch(() => {});
}

// Explore: the newest reviews across every book, 30 at a time.
export async function latestReviews(after = null) {
  const { db, fs } = await load();
  const parts = [fs.collectionGroup(db, 'reviews'), fs.orderBy('createdAt', 'desc')];
  if (after) parts.push(fs.startAfter(after));
  parts.push(fs.limit(30));
  const res = await fs.getDocs(fs.query(...parts));
  return { list: res.docs.map((s) => toReview2(s, !s.data().bookKey)), last: res.docs.at(-1) || null };
}

// ----- reports + admin -----

export async function report(workId, reviewerUid, uid, reason) {
  const { db, fs } = await load();
  await fs.setDoc(fs.doc(db, 'reports', `${workId}_${reviewerUid}_${uid}`), { workId, reviewerUid, uid, reason, createdAt: fs.serverTimestamp() });
}

export async function listReports() {
  const { db, fs } = await load();
  const res = await fs.getDocs(fs.query(fs.collection(db, 'reports'), fs.limit(50)));
  return res.docs.map((s) => ({ id: s.id, ...s.data() }));
}

export async function dismissReport(id) {
  const { db, fs } = await load();
  await fs.deleteDoc(fs.doc(db, 'reports', id));
}

// Delete everything public this account wrote, then the Firebase account. users/{uid} and the
// handle stay behind on purpose: they reserve the name forever (see privacy.html).
// Re-authenticates first with a fresh Google token: Firebase refuses user.delete() on an old
// session, and failing that after the reviews were gone would leave the job half done.
export async function deleteMyPublicData(uid, workIds, accessToken) {
  const { db, fs, fa, auth } = await load();
  if (auth.currentUser?.uid !== uid) throw new Error('not-signed-in-as-owner');
  await fa.reauthenticateWithCredential(auth.currentUser, fa.GoogleAuthProvider.credential(null, accessToken));
  // Every review this account wrote, wherever it is (books/ and 1.x works/), in pages of 30 - not
  // just the books still in this phone's diary. The local keys are a belt-and-braces second pass.
  for (;;) {
    const mine = await fs.getDocs(fs.query(fs.collectionGroup(db, 'reviews'), fs.where('uid', '==', uid), fs.limit(30)));
    if (mine.empty) break;
    for (const d of mine.docs) await fs.deleteDoc(d.ref);
  }
  for (const k of workIds) {
    await fs.deleteDoc(fs.doc(db, 'books', k, 'reviews', uid));
    if (k.startsWith('ol:')) await fs.deleteDoc(fs.doc(db, 'works', k.slice(3), 'reviews', uid));
  }
  const mine = await fs.getDocs(fs.query(fs.collection(db, 'reports'), fs.where('uid', '==', uid)));
  for (const d of mine.docs) await fs.deleteDoc(d.ref);
  await auth.currentUser.delete();
}
