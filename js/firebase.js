// The public layer: Firebase Auth (signed in with the Google token the app already has) and the
// Firestore reviews database. The SDK loads lazily, so the private diary never waits on it.

import { FIREBASE_CONFIG } from './config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
let sdk = null; // { app, auth, db, fa, fs }
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

// ----- reviews -----

const toReview = (snap) => {
  const d = snap.data();
  return { id: snap.id, uid: d.uid, handle: d.handle, rating: d.rating, text: d.text, workId: d.workId,
    createdAt: d.createdAt?.toMillis?.() || 0, updatedAt: d.updatedAt?.toMillis?.() || 0, snap };
};

export async function listReviews(workId, after = null) {
  const { db, fs } = await load();
  const parts = [fs.collection(db, 'works', workId, 'reviews'), fs.orderBy('createdAt', 'desc')];
  if (after) parts.push(fs.startAfter(after.snap));
  parts.push(fs.limit(50));
  const res = await fs.getDocs(fs.query(...parts));
  return res.docs.map(toReview);
}

// Create, or edit rating/text only: the rules refuse any other change.
export async function upsertReview(uid, handle, workId, rating, text) {
  const { db, fs } = await load();
  const ref = fs.doc(db, 'works', workId, 'reviews', uid);
  const existing = await fs.getDoc(ref);
  if (existing.exists()) {
    await fs.updateDoc(ref, { rating, text, updatedAt: fs.serverTimestamp() });
  } else {
    await fs.setDoc(ref, { workId, uid, handle, rating, text, createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp() });
  }
}

export async function deleteReview(workId, uid) {
  const { db, fs } = await load();
  await fs.deleteDoc(fs.doc(db, 'works', workId, 'reviews', uid));
}

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
  for (const w of workIds) await fs.deleteDoc(fs.doc(db, 'works', w, 'reviews', uid));
  const mine = await fs.getDocs(fs.query(fs.collection(db, 'reports'), fs.where('uid', '==', uid)));
  for (const d of mine.docs) await fs.deleteDoc(d.ref);
  await auth.currentUser.delete();
}
