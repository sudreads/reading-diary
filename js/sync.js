// One sync cycle. Each device writes only its own device-<id>.json and merges everyone else's,
// so two devices can never overwrite each other. `store` and `drive` are injected so the
// tests can run every interleaving against an in-memory fake.

import { validateBackup } from './validate.js';

export const SCHEMA_VERSION = 1;
export const deviceFileName = (deviceId) => `device-${deviceId}.json`;

const FUTURE_SLACK = 365 * 24 * 3600 * 1000;

export async function runSync({ store, drive, deviceId, now = () => Date.now() }) {
  const gen = await store.getMeta('mutationGen', 0);
  const seen = { ...(await store.getMeta('remoteSeen', {})) };
  const myName = deviceFileName(deviceId);
  const files = await drive.listDeviceFiles();
  const notes = [];

  for (const f of files) {
    if (f.name === myName || seen[f.id] === f.modifiedTime) continue;
    const raw = await drive.downloadJson(f.id);
    if (raw && raw.schemaVersion > SCHEMA_VERSION) { notes.push('newer-app-on-other-device'); continue; }
    const { data, errors, fatal } = validateBackup(raw, { maxT: now() + FUTURE_SLACK });
    if (fatal) { notes.push('unreadable-device-file'); continue; }
    await store.mergeIn(data);
    // A file with rejected records stays unseen, so a later app version can take them.
    if (errors.length) notes.push(`skipped-${errors.length}-bad-records`);
    else seen[f.id] = f.modifiedTime;
  }

  for (const d of await store.pendingDrawings()) {
    await drive.ensureDrawing(`drawing-${d.id}.webp`, d.blob);
    await store.markDrawingUploaded(d.id);
  }

  const state = await store.snapshot();
  const myId = (await store.getMeta('myFileId', null)) || files.find((f) => f.name === myName)?.id || null;
  const up = await drive.uploadDeviceFile(myId, myName, {
    app: 'reading-diary', schemaVersion: SCHEMA_VERSION, deviceId, savedAt: now(), ...state,
  });
  const check = await drive.getFileMeta(up.id);
  if (!check || check.modifiedTime !== up.modifiedTime) throw new Error('upload-not-confirmed');

  await store.setMeta('myFileId', up.id);
  await store.setMeta('remoteSeen', seen);
  await store.setMeta('syncedThroughGen', gen);
  await store.setMeta('lastSyncOk', now());
  return { ok: true, gen, notes };
}

// Only one cycle per device at a time, across tabs too.
export function withSyncLock(locks, fn) {
  if (!locks || typeof locks.request !== 'function') return fn();
  return locks.request('rd-sync', { ifAvailable: true }, (lock) => (lock ? fn() : { ok: false, busy: true }));
}

export function backoffMs(failures) {
  return Math.min(30 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, failures - 1));
}
