// When to sync, and what the status pill should say. 2.0: the private diary syncs with the reader
// account (cloud.js, needs only the persistent Firebase session); Google Drive is used for drawings
// (and, until a diary has been moved, for the old per-device files in sync.js).

import * as store from './store.js';
import * as drive from './drive.js';
import * as fb from './firebase.js';
import { runSync, withSyncLock, backoffMs } from './sync.js';
import { drainOutbox } from './social.js';
import { signOutReady, backupCovers } from './signout.js';
import { pushDirty, pullChanges, cloudCovers } from './cloud.js';
import { EXPECTED_EMAIL } from './config.js';

// account: 'off' (no Firebase), 'signed-out', 'needs-handle', 'ready', 'wrong-account'
export const state = { drive: 'not-configured', email: '', syncing: false, failures: 0, error: '',
  account: 'off', uid: '', handle: '', admin: false, checked: false, cloudSyncing: false };
const listeners = new Set();
let debounce = null, retry = null, drainTimer = null, drainFailures = 0;
let cloudTimer = null, cloudRetry = null, cloudFailures = 0, pullTimer = null;
const lock = (name, fn, ifAvailable = false) => (navigator.locks
  ? navigator.locks.request(name, ifAvailable ? { ifAvailable: true } : {}, (l) => (l ? fn() : { busy: true }))
  : fn());

export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// After sign-out this tab's store is gone; late timers must not touch it (or the screen).
const emit = () => { if (!stopped || state.signedOut) listeners.forEach((fn) => fn(state)); };

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
  state.checked = true;
  if (state.handle) await store.setMeta('ownerHandle', state.handle);
  if (user.email) await store.setMeta('ownerEmail', user.email); // "signed in as", without Drive
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
    const res = (await store.getMeta('migratedV2', false))
      ? await withSyncLock(navigator.locks, () => catchUpLegacyThenDrawings(deviceId))
      : await withSyncLock(navigator.locks, () => runSync({ store, drive: drive.driveApi, deviceId }));
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
  cloudSync();
}

export function scheduleSoon() {
  clearTimeout(debounce);
  debounce = setTimeout(() => syncNow(), 5000);
}

// A diary moved without a Drive token may still have records that only an old phone wrote to
// Drive. The first time Drive is connected after the move, merge those files once (the merge marks
// nothing dirty, so mark what arrived) and let the account upload pick them up.
async function catchUpLegacyThenDrawings(deviceId) {
  if (!(await store.getMeta('legacyDriveMerged', false))) {
    const before = new Set((await store.allDocs()).map((d) => `${d.rid}@${d.t}@${d.d}`));
    await runSync({ store, drive: drive.driveApi, deviceId });
    const arrived = (await store.allDocs()).filter((d) => !before.has(`${d.rid}@${d.t}@${d.d}`));
    if (arrived.length) {
      await store.markDirtyDocs(arrived);
      scheduleCloud(1000);
    }
    await store.setMeta('legacyDriveMerged', true);
  }
  return uploadDrawings();
}

// Drawings live in the owner's Drive; upload any that aren't there yet (needs a Drive token).
async function uploadDrawings() {
  for (const d of await store.pendingDrawings()) {
    await drive.driveApi.ensureDrawing(`drawing-${d.id}.webp`, d.blob);
    await store.markDrawingUploaded(d.id);
  }
  return { ok: true, notes: ['drawings'] };
}

// ----- private diary in the reader account (2.0) -----

const local = {
  dirty: () => store.dirty(),
  docFor: (rid) => store.docFor(rid),
  ack: (rid, t) => store.dirtyAck(rid, t),
  mergeRemote: (docs) => store.mergeRemoteDocs(docs),
  getCursor: () => store.getMeta('cloudCursor', 0),
  setCursor: (v) => store.setMeta('cloudCursor', v),
};
// Only once Firebase has confirmed the session (state.checked) - the remembered uid alone isn't auth.
const canCloud = () => !stopped && fb.isConfigured() && state.checked && !!state.uid
  && (state.account === 'ready' || state.account === 'needs-handle') && navigator.onLine;

// One-time, resumable move of a diary into the account: pick up Drive data from other phones if a
// Drive token happens to be available, queue every record, upload, then prove every record arrived
// before switching the diary to cloud mode. Until then 1.x Drive sync keeps running as before.
async function migrate() {
  if (drive.hasToken()) {
    const deviceId = await store.getMeta('deviceId');
    const merged = await withSyncLock(navigator.locks, () => runSync({ store, drive: drive.driveApi, deviceId })).catch(() => null);
    if (merged?.ok) await store.setMeta('legacyDriveMerged', true);
  }
  if (!(await store.getMeta('migrationQueued', false))) {
    await store.markAllDirty();
    await store.setMeta('migrationQueued', true);
  }
  const api = fb.recordsApi(state.uid);
  const pushed = await pushDirty({ store: local, api });
  state.stuck = pushed.skipped;
  // Records still dirty now are either brand-new edits (they upload normally in cloud mode) or
  // ones the account refused (they stay safe on this phone and the pill says so). Neither should
  // hold up the move, so the proof covers everything that isn't dirty.
  const stillDirty = new Set(Object.keys(await store.dirty()));
  const remote = new Map();
  let after = null, newest = 0;
  for (;;) {
    const { docs, last } = await api.page(0, after);
    for (const d of docs) { remote.set(d.rid, d); if (d.uMs > newest) newest = d.uMs; }
    if (docs.length) await store.mergeRemoteDocs(docs); // another phone's diary arrives here too
    if (!last || docs.length < api.pageSize) break;
    after = last;
  }
  const gap = cloudCovers((await store.allDocs()).filter((d) => !stillDirty.has(d.rid)), remote);
  if (gap) { await store.log('move-to-account', false, gap); return false; }
  await store.setMeta('cloudCursor', newest);
  await store.setMeta('verifiedT', await store.getMeta('highestT', 0));
  await store.setMeta('migratedV2', true);
  await store.log('move-to-account', true, `${remote.size} records`);
  return true;
}

export async function cloudSync({ pull = true, wait = false } = {}) {
  clearTimeout(cloudTimer);
  clearTimeout(cloudRetry);
  if (!canCloud()) return;
  state.cloudSyncing = true;
  emit();
  try {
    const res = await lock('rd-cloud', async () => {
      if (!(await store.getMeta('migratedV2', false))) return migrate();
      const api = fb.recordsApi(state.uid);
      const pushed = await pushDirty({ store: local, api });
      state.stuck = pushed.skipped; // refused by the account: shown in the pill, kept on the phone
      if (pushed.skipped) await store.log('account-sync', false, `${pushed.skipped} change(s) refused`);
      if (pull) await pullChanges({ store: local, api });
      await store.setMeta('lastCloudOk', Date.now());
      return true;
    }, !wait);
    if (res?.busy) { cloudTimer = setTimeout(() => cloudSync({ pull }), 3000); return; }
    cloudFailures = 0;
    if (Object.keys(await store.dirty()).length && (await store.getMeta('migratedV2', false))) scheduleCloud();
  } catch (e) {
    if (stopped) return;
    cloudFailures++;
    await store.log('account-sync', false, e.code || e.message);
    cloudRetry = setTimeout(() => cloudSync(), backoffMs(cloudFailures));
  } finally {
    state.cloudSyncing = false;
    emit();
  }
}

// Edits are saved in batches: at most one upload every 30 seconds while writing.
export function scheduleCloud(ms = 30000) {
  if (cloudTimer) return;
  cloudTimer = setTimeout(() => { cloudTimer = null; cloudSync({ pull: false }); }, ms);
}

// ----- public reviews -----

export async function claimHandle(handle) {
  await fb.claimHandle(state.uid, handle);
  await store.setMeta('ownerHandle', handle);
  state.handle = handle;
  state.account = 'ready';
  emit();
  drainReviews();
}

export async function drainReviews() {
  if (stopped) return;
  clearTimeout(drainTimer);
  // Only after Firebase confirmed the session; the remembered "ready" alone isn't auth.
  if (state.account !== 'ready' || !state.checked || !navigator.onLine) return;
  const entries = await store.getMeta('reviewOutbox', {});
  if (!Object.keys(entries).length) return;
  const { uid, handle } = state;
  try {
    const res = await withSyncLock(navigator.locks, () => drainOutbox({
      entries,
      getBook: (id) => store.getRaw('books', id),
      api: {
        upsertReview: (book, rating, text) => fb.upsertReview2(uid, handle, book, rating, text),
        deleteReview: (key) => fb.deleteReview2(key, uid),
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
  const { bookKeyOf } = await import('./catalog.js');
  const workIds = [...new Set(books.map((b) => bookKeyOf(b)).filter(Boolean))];
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
  clearTimeout(cloudTimer); clearTimeout(cloudRetry); clearInterval(pullTimer);
  drive.forget();
}

// Wipes this phone only after proving Drive holds everything. Throws a plain-language reason if
// anything is not provably safe; nothing is deleted in that case. say() reports progress.
export async function signOut(say = () => {}) {
  const fail = (msg) => { throw new Error(msg); };
  if (!navigator.onLine) fail(signOutReady({ online: false }));

  if (await store.getMeta('migratedV2', false)) return signOutCloud(say, fail);

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

async function signOutCloud(say, fail) {
  const user = await fb.currentUser();
  if (!user || user.uid !== (await store.getMeta('ownerUid', ''))) fail('Sign in to your reader account first, then try again.');
  say('Saving everything to your account…');
  await cloudSync({ pull: false, wait: true });
  if (Object.keys(await store.dirty()).length) fail('Some changes aren\'t saved to your account yet. Check your internet and try again.');
  const genAtProof = (await store.status()).mutationGen;

  say('Checking the backup…');
  const verifiedT = await store.getMeta('verifiedT', 0);
  const changed = (await store.allDocs()).filter((d) => d.t > verifiedT);
  const api = fb.recordsApi(user.uid);
  const remote = new Map();
  for (const d of changed) { const r = await api.getOne(d.rid).catch(() => null); if (r) remote.set(d.rid, r); }
  const gap = cloudCovers(changed, remote);
  if (gap) fail(`Your account copy isn't complete yet (${gap}). Try again in a moment.`);

  const drawings = (await store.list('blocks')).filter((b) => b.drawingId);
  if (drawings.length) {
    say('Checking your drawings in Google Drive…');
    if (!(await ensureConnected(true))) fail('Connect Google Drive so your drawings are backed up, then try again.');
    await uploadDrawings();
    const names = await drive.driveApi.listDrawingNames().catch((e) => fail(`Couldn't check drawings in Drive (${e.message}). Try again.`));
    for (const b of drawings) {
      if (!names.has(`drawing-${b.drawingId}.webp`)) fail('A drawing is missing from Drive. Try again in a moment.');
      const mine = await store.getDrawing(b.drawingId);
      const back = await drive.driveApi.downloadDrawing(b.drawingId).catch(() => null);
      if (!back || (mine && back.size !== mine.blob.size)) fail('A drawing in Drive doesn\'t match this phone. Try again in a moment.');
    }
  }
  // Last look right before wiping: any edit since the proof started (even one with its dirty mark
  // already cleared by a racing upload) stops the wipe.
  if (Object.keys(await store.dirty()).length || (await store.status()).mutationGen !== genAtProof) fail('Something changed while checking. Try again.');
  await store.setMeta('verifiedT', await store.getMeta('highestT', 0));

  say('Signing out…');
  channel?.postMessage('signing-out');
  stopAll();
  await fb.signOut();
  if (await fb.currentUser()) fail('Couldn\'t sign out of the reader account. Try again.');
  try { await store.wipe(); } catch (e) {
    const err = new Error(e.message === 'blocked'
      ? 'Your diary is safely in your account. Reading Diary is still open in another tab: close it, then reload to finish signing out.'
      : `Your diary is safely in your account, but this phone couldn't be cleared (${e.message}). Reload and try again.`);
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
  store.onChange(async (why) => {
    if (why === 'outbox') { clearTimeout(drainTimer); drainTimer = setTimeout(drainReviews, 1500); }
    else if (why !== 'merge') {
      if (await store.getMeta('migratedV2', false)) {
        scheduleCloud();
        if ((await store.pendingDrawings()).length && drive.hasToken()) scheduleSoon();
      } else scheduleSoon();
    }
    emit();
  });
  window.addEventListener('online', () => { cloudSync(); syncNow(); });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      cloudSync({ pull: false }); // save now, don't wait for the 30 s batch
      if (state.drive === 'connected' && (await store.status()).pending > 0) syncNow();
    }
    if (document.visibilityState === 'visible') { cloudSync(); syncNow(); }
  });
  // While the app is open, pick up changes from your other phones every 5 minutes.
  pullTimer = setInterval(() => { if (document.visibilityState === 'visible') cloudSync(); }, 5 * 60 * 1000);
  if (fb.isConfigured()) {
    state.account = 'signed-out';
    // Show who you are immediately from what this phone remembers; Firebase only refines it.
    // (The old flash of "Sign in" came from waiting for Firebase before drawing anything.)
    Promise.all([store.getMeta('ownerUid', ''), store.getMeta('ownerHandle', '')]).then(([owner, handle]) => {
      if (owner) { state.uid = owner; state.handle = handle; state.account = handle ? 'ready' : 'checking'; emit(); }
      return owner && fb.currentUser();
    }).then(async (user) => {
      state.checked = true;
      if (user && (await bindAccount(user))) { emit(); drainReviews(); cloudSync(); }
      else { if (state.account !== 'wrong-account') { state.account = 'signed-out'; state.uid = ''; } emit(); }
    }).catch(() => { state.checked = true; emit(); });
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
