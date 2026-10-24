// When to sync, and what the status pill should say. The cycle itself lives in sync.js.

import * as store from './store.js';
import * as drive from './drive.js';
import { runSync, withSyncLock, backoffMs } from './sync.js';
import { EXPECTED_EMAIL } from './config.js';

export const state = { drive: 'not-configured', email: '', syncing: false, failures: 0, error: '' };
const listeners = new Set();
let debounce = null, retry = null;

export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach((fn) => fn(state));

async function ensureConnected(interactive) {
  if (!drive.isConfigured()) { state.drive = 'not-configured'; return false; }
  // Google's sign-in popup needs a tap; automatic syncs wait for one instead of failing.
  if (!interactive && !drive.hasToken()) { if (state.drive !== 'disconnected') state.drive = 'signed-out'; return false; }
  try {
    await drive.connect({ interactive });
    state.email = await drive.whoAmI();
    const confirmed = await store.getMeta('confirmedEmail', '');
    if (state.email !== confirmed && (!EXPECTED_EMAIL || state.email !== EXPECTED_EMAIL)) { state.drive = 'needs-confirm'; return false; }
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
  state.drive = 'connected';
  emit();
  return syncNow();
}

export async function syncNow({ interactive = false } = {}) {
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
}

export function scheduleSoon() {
  clearTimeout(debounce);
  debounce = setTimeout(() => syncNow(), 5000);
}

export function start() {
  store.onChange((why) => { if (why !== 'merge') scheduleSoon(); emit(); });
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden' && state.drive === 'connected' && (await store.status()).pending > 0) syncNow();
    if (document.visibilityState === 'visible') syncNow();
  });
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
