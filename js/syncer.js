// When to sync, and what the status pill should say. The cycle itself lives in sync.js; the public
// reviews layer (Firebase) rides on the same Google sign-in.

import * as store from './store.js';
import * as drive from './drive.js';
import * as fb from './firebase.js';
import { runSync, withSyncLock, backoffMs } from './sync.js';
import { drainOutbox } from './social.js';
import { signOutReady, backupCovers } from './signout.js';
import { EXPECTED_EMAIL } from './config.js';

// account: 'off' (no Firebase), 'signed-out', 'needs-handle', 'ready', 'wrong-account'
export const state = { drive: 'not-configured', email: '', syncing: false, failures: 0, error: '',
  account: 'off', uid: '', handle: '', admin: false };
const listeners = new Set();
let debounce = null, retry = null, drainTimer = null, drainFailures = 0;

export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach((fn) => fn(state));

// The diary on this device belongs to one account. Called with every Firebase user we see.
async function bindAccount(user) {
  const owner = await store.getMeta('ownerUid', '');
  if (owner && owner !== user.uid) {
    await fb.signOut();
    state.account = 'wrong-account';
    return false;
  }
  if (!owner) await store.setMeta('ownerUid', user.uid);
  state.accountError = '';
  state.uid = user.uid;
  state.handle = (await fb.myHandle(user.uid)) || '';
  state.account = state.handle ? 'ready' : 'needs-handle';
  state.admin = state.handle ? await fb.isAdmin(user.uid) : false;
  return true;
}

async function ensureConnected(interactive) {
  if (!drive.isConfigured()) { state.drive = 'not-configured'; return false; }
  // Google's sign-in popup needs a tap; automatic syncs wait for one instead of failing.
  if (!interactive && !drive.hasToken()) { if (state.drive !== 'disconnected') state.drive = 'signed-out'; return false; }
  try {
    const chooseAccount = state.drive === 'wrong-account' || state.account === 'wrong-account';
    await drive.connect({ interactive, chooseAccount });
    const who = await drive.whoAmI();
    state.email = who.email;
    // Google's permanent account id is the real owner check; emails can change hands.
    const ownerSub = await store.getMeta('ownerGoogleSub', '');
    if (ownerSub && who.sub !== ownerSub) { drive.forget(); state.drive = 'wrong-account'; return false; }
    let confirmed = await store.getMeta('confirmedEmail', '');
    // First sign-in on this device: he just picked this account in Google's own chooser, so
    // asking "use this account?" again only looked like a second sign-up. Later mismatches still ask.
    if (!confirmed && interactive && !(await store.getMeta('ownerUid', ''))) {
      confirmed = state.email;
      await store.setMeta('confirmedEmail', confirmed);
    }
    if (state.email !== confirmed && (!EXPECTED_EMAIL || state.email !== EXPECTED_EMAIL)) {
      // A phone already bound to a reader account never adopts another one ("use this one?" would
      // only create a stray account); diaries from before accounts still get asked.
      if (await store.getMeta('ownerUid', '')) { drive.forget(); state.drive = 'wrong-account'; return false; }
      state.drive = 'needs-confirm';
      return false;
    }
    if (fb.isConfigured()) {
      // A broken public layer must never stop the private Drive backup; only a wrong account does.
      try {
        const user = await fb.signInWithGoogleToken(drive.accessToken(), state.email);
        const googleId = user.providerData?.find((p) => p.providerId === 'google.com')?.uid;
        const sameEmail = (user.email || '').toLowerCase() === state.email.toLowerCase() && (!googleId || googleId === who.sub);
        if (!sameEmail || !(await bindAccount(user))) {
          if (!sameEmail) { await fb.signOut(); state.account = 'wrong-account'; }
          drive.forget();
          state.drive = 'wrong-account';
          return false;
        }
      } catch (e) {
        if (state.account !== 'ready') state.account = 'signed-out';
        state.accountError = e.code || e.message; // shown on the sign-in screen
        await store.log('reviews-sign-in', false, state.accountError);
      }
    }
    if (!ownerSub && who.sub) await store.setMeta('ownerGoogleSub', who.sub);
    await store.setMeta('ownerEmail', who.email); // shown in Settings: "signed in as"
    state.drive = 'connected';
    return true;
  } catch (e) {
    state.drive = 'disconnected';
    state.error = e.message;
    await store.log('connect', false, e.message);
    return false;
  }
}

export async function confirmAccount() {
  await store.setMeta('confirmedEmail', state.email);
  emit();
  return syncNow({ interactive: true });
}

export async function syncNow({ interactive = false } = {}) {
  if (stopped) return; // signed out: this tab must never touch Drive again
  clearTimeout(debounce);
  clearTimeout(retry);
  if (!navigator.onLine) { state.error = 'offline'; emit(); return; }
  if (!(await ensureConnected(interactive))) { emit(); return; }
  state.syncing = true;
  emit();
  try {
    const deviceId = await store.getMeta('deviceId');
    const res = await withSyncLock(navigator.locks, () => runSync({ store, drive: drive.driveApi, deviceId }));
    if (res.busy) return;
    state.failures = 0;
    state.error = '';
    await store.log('sync', true, res.notes.join(','));
    if (!(await store.getMeta('reviewsReconciled', false))) {
      for (const b of await store.list('books')) if (b.publicReview === true) await store.outboxBump(b.id);
      await store.setMeta('reviewsReconciled', true);
    }
    if ((await store.status()).pending > 0) scheduleSoon(); // edits landed mid-cycle
  } catch (e) {
    state.failures++;
    state.error = e.message;
    if (e.message === 'token-expired') { drive.forget(); state.drive = 'signed-out'; }
    await store.log('sync', false, e.message);
    retry = setTimeout(() => syncNow(), backoffMs(state.failures));
  } finally {
    state.syncing = false;
    emit();
  }
  drainReviews();
}

export function scheduleSoon() {
  clearTimeout(debounce);
  debounce = setTimeout(() => syncNow(), 5000);
}

// ----- public reviews -----

export async function claimHandle(handle) {
  await fb.claimHandle(state.uid, handle);
  state.handle = handle;
  state.account = 'ready';
  emit();
  drainReviews();
}

export async function drainReviews() {
  if (stopped) return;
  clearTimeout(drainTimer);
  if (state.account !== 'ready' || !navigator.onLine) return;
  const entries = await store.getMeta('reviewOutbox', {});
  if (!Object.keys(entries).length) return;
  const { uid, handle } = state;
  try {
    const res = await withSyncLock(navigator.locks, () => drainOutbox({
      entries,
      getBook: (id) => store.getRaw('books', id),
      api: {
        upsertReview: (w, rating, text) => fb.upsertReview(uid, handle, w, rating, text),
        deleteReview: (w) => fb.deleteReview(w, uid),
      },
      ack: store.outboxAck,
    }), 'rd-reviews');
    if (res?.busy) { drainTimer = setTimeout(drainReviews, 3000); return; }
    drainFailures = 0;
    await store.log('reviews', true, `${res.length} sent`);
    if (Object.keys(await store.getMeta('reviewOutbox', {})).length) drainTimer = setTimeout(drainReviews, 2000);
  } catch (e) {
    drainFailures++;
    await store.log('reviews', false, e.code || e.message);
    drainTimer = setTimeout(drainReviews, backoffMs(drainFailures));
  }
  emit();
}

export async function deleteMyPublicData() {
  const books = await store.all('books');
  const { workIdOf } = await import('./social.js');
  const workIds = [...new Set(books.map((b) => workIdOf(b.olKey)).filter(Boolean))];
  await drive.connect({ interactive: true }); // fresh token for Firebase's re-authentication
  // Marked first so an interrupted delete shows "finish deleting" instead of looking done.
  await store.setMeta('deleteJob', true);
  // Same lock as the outbox drain, waiting for it: no upsert can land after these deletes.
  const run = () => fb.deleteMyPublicData(state.uid, workIds, drive.accessToken());
  await (navigator.locks ? navigator.locks.request('rd-reviews', run) : run());
  await store.setMeta('reviewOutbox', {});
  await store.setMeta('deleteJob', false);
  // Signing in again makes a brand-new Firebase account, so this diary must accept its new uid.
  await store.setMeta('ownerUid', '');
  state.account = 'signed-out';
  state.uid = state.handle = '';
  state.admin = false;
  emit();
}

// ----- sign out -----

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('reading-diary') : null;
let stopped = false;

function stopAll() {
  stopped = true;
  clearTimeout(debounce); clearTimeout(retry); clearTimeout(drainTimer);
  drive.forget();
}

// Wipes this phone only after proving Drive holds everything. Throws a plain-language reason if
// anything is not provably safe; nothing is deleted in that case. say() reports progress.
export async function signOut(say = () => {}) {
  const fail = (msg) => { throw new Error(msg); };
  if (!navigator.onLine) fail(signOutReady({ online: false }));

  say('Connecting to your Google Drive…');
  if (!(await ensureConnected(true))) {
    fail(state.drive === 'wrong-account' ? 'Pick the Google account this diary belongs to, then try again.' : 'Couldn\'t connect to Google Drive. Try again.');
  }

  say('Saving everything to Drive…');
  const deviceId = await store.getMeta('deviceId');
  const lock = (name, fn) => (navigator.locks ? navigator.locks.request(name, fn) : fn());
  try {
    await lock('rd-sync', () => runSync({ store, drive: drive.driveApi, deviceId }));
  } catch (e) {
    fail(e.message === 'token-expired' ? 'Google sign-in expired. Tap Try again to reconnect.' : `Couldn't save to Drive (${e.message}). Check your internet and try again.`);
  }
  say('Posting your public reviews…');
  await drainReviews();

  say('Checking the backup…');
  const st = await store.status();
  const reason = signOutReady({
    online: navigator.onLine, mutationGen: st.mutationGen, syncedThroughGen: st.syncedThroughGen,
    unsentDrawings: (await store.pendingDrawings()).length,
  });
  if (reason) fail(reason);
  const local = await store.snapshot();
  const remote = await drive.driveApi.downloadJson(await store.getMeta('myFileId')).catch(() => null);
  const gap = backupCovers(local, remote);
  if (gap) fail(`The Drive backup isn't complete yet (${gap}). Try again in a moment.`);
  const names = await drive.driveApi.listDrawingNames().catch((e) => fail(`Couldn't check drawings in Drive (${e.message}). Try again.`));
  for (const b of local.blocks.filter((x) => !x.deleted && x.drawingId)) {
    if (!names.has(`drawing-${b.drawingId}.webp`)) fail('A drawing is missing from Drive. Try again in a moment.');
    const mine = await store.getDrawing(b.drawingId);
    const back = await drive.driveApi.downloadDrawing(b.drawingId).catch(() => null);
    if (!back || (mine && back.size !== mine.blob.size)) fail('A drawing in Drive doesn\'t match this phone. Try again in a moment.');
  }

  // Last look right before wiping: an edit that slipped in during the checks stops it here.
  const last = await store.status();
  if (last.mutationGen !== st.mutationGen || last.mutationGen !== last.syncedThroughGen) fail('Something changed while checking. Try again.');

  say('Signing out…');
  channel?.postMessage('signing-out');
  stopAll();
  await fb.signOut();
  if (await fb.currentUser()) fail('Couldn\'t sign out of the reader account. Try again.');
  try { await store.wipe(); } catch (e) {
    const err = new Error(e.message === 'blocked'
      ? 'Your diary is safely in Drive. Reading Diary is still open in another tab: close it, then reload to finish signing out.'
      : `Your diary is safely in Drive, but this phone couldn't be cleared (${e.message}). Reload and try again.`);
    err.reload = true;
    throw err;
  }
}

export function start() {
  channel?.addEventListener('message', (e) => {
    if (e.data !== 'signing-out') return;
    stopAll();
    store.kill(); // this tab can never write the old diary back
    state.signedOut = true;
    emit();
  });
  store.onChange((why) => {
    if (why === 'outbox') { clearTimeout(drainTimer); drainTimer = setTimeout(drainReviews, 1500); }
    else if (why !== 'merge') scheduleSoon();
    emit();
  });
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden' && state.drive === 'connected' && (await store.status()).pending > 0) syncNow();
    if (document.visibilityState === 'visible') syncNow();
  });
  if (fb.isConfigured()) {
    state.account = 'signed-out';
    // Firebase remembers its own session, so reviews work even before Drive gets a fresh token.
    // Only fetch the SDK if this diary has signed in before.
    store.getMeta('ownerUid', '').then((owner) => owner && fb.currentUser())
      .then(async (user) => { if (user && (await bindAccount(user))) { emit(); drainReviews(); } else emit(); })
      .catch(() => {});
  }
  if (drive.isConfigured()) syncNow();
  emit();
}

// Local first; fetch from Drive only when a drawing came from another device.
export async function drawingBlob(id) {
  const local = await store.getDrawing(id);
  if (local) return local.blob;
  if (!drive.hasToken()) return null;
  const blob = await drive.driveApi.downloadDrawing(id);
  if (blob) await store.putRemoteDrawing(id, blob);
  return blob;
}
