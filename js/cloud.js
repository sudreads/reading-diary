// 2.0 private-diary sync with the reader account (Firestore users/{uid}/records/*). Pure logic
// with the database injected, so tests run it against a fake. Local IndexedDB stays the main copy.
//
// Record documents: { kind, id, data, t, d, deleted, u }. A block's rank is its own record kind
// ('rank'), so every document carries exactly one revision (t, d) and the rules can refuse any
// write that isn't strictly newer than what is stored.

import { cmpRev } from './rev.js';

export const MAX_DOC_BYTES = 100 * 1024; // same number as PLAN-v2 and the client check
const strip = (rec, drop) => {
  const out = {};
  for (const [k, v] of Object.entries(rec)) if (!drop.includes(k) && v !== undefined) out[k] = v;
  return JSON.parse(JSON.stringify(out)); // no undefined, no Dates/Blobs - Firestore-safe
};

export const ridOf = (kind, id) => `${kind}_${id}`;

// Local record -> the documents it maps to. which: 'content' | 'rank' | 'both'.
export function toDocs(kind, rec, which = 'both') {
  const docs = [];
  if (which !== 'rank' && rec.rev) {
    const drop = kind === 'blocks' ? ['id', 'rev', 'deleted', 'rank', 'rankRev'] : ['id', 'rev', 'deleted'];
    docs.push({ rid: ridOf(kind, rec.id), kind, id: rec.id, data: strip(rec, drop), t: rec.rev.t, d: rec.rev.d, deleted: !!rec.deleted });
  }
  if (kind === 'blocks' && which !== 'content' && rec.rankRev) {
    docs.push({ rid: ridOf('rank', rec.id), kind: 'rank', id: rec.id, data: { rank: rec.rank || '' }, t: rec.rankRev.t, d: rec.rankRev.d, deleted: false });
  }
  return docs;
}

// Remote document -> [local store kind, partial local record] for mergeIn.
export function fromDoc(doc) {
  if (doc.kind === 'rank') return ['blocks', { id: doc.id, rank: doc.data?.rank || '', rankRev: { t: doc.t, d: doc.d } }];
  return [doc.kind, { ...doc.data, id: doc.id, rev: { t: doc.t, d: doc.d }, deleted: !!doc.deleted }];
}

export function docTooBig(doc) {
  return JSON.stringify(doc).length * 2 > MAX_DOC_BYTES; // UTF-16 upper bound, conservative
}

const revOf = (d) => ({ t: d.t, d: d.d });

// Push every dirty record. store: { dirty() -> {rid: t}, docFor(rid) -> doc|null, ack(rid, t),
// mergeRemote(docs) }. api: { writeBatch(docs), writeOne(doc), getOne(rid) -> doc|null }.
// A batch that fails falls back to one-by-one writes; a write refused because the cloud already
// holds an equal-or-newer revision pulls that revision in instead. Returns { sent, skipped (refused
// by the rules), failed (network) }.
export async function pushDirty({ store, api, batchSize = 400 }) {
  const dirty = await store.dirty();
  const items = [];
  for (const [rid, t] of Object.entries(dirty)) {
    const doc = await store.docFor(rid);
    if (!doc) { await store.ack(rid, t); continue; } // record vanished locally: nothing to send
    if (docTooBig(doc)) continue; // stays dirty; the UI reports it
    items.push({ rid, t, doc });
  }
  let sent = 0, skipped = 0, failed = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    try {
      await api.writeBatch(chunk.map((x) => x.doc));
      for (const x of chunk) await store.ack(x.rid, x.t);
      sent += chunk.length;
    } catch {
      for (const x of chunk) {
        try {
          await api.writeOne(x.doc);
          await store.ack(x.rid, x.t);
          sent++;
        } catch (e) {
          const remote = await api.getOne(x.rid).catch(() => null);
          if (remote && cmpRev(revOf(remote), revOf(x.doc)) >= 0) {
            await store.mergeRemote([remote]); // the cloud is ahead: adopt it, nothing to push
            await store.ack(x.rid, x.t);
          } else if (e?.code === 'permission-denied') {
            skipped++; // the account refuses this record: stays dirty, kept on the phone, reported
          } else {
            failed++; // network trouble: stays dirty, retried quietly
          }
        }
      }
    }
  }
  return { sent, skipped, failed };
}

// Pull everything changed since the cursor (server time `u`, 2-minute overlap; merging is
// idempotent so re-reading a few documents is harmless). api.page(sinceMs, after) -> { docs:
// [{...doc, uMs}], last }. Returns the number of documents read.
export async function pullChanges({ store, api, overlapMs = 120000 }) {
  const cursor = await store.getCursor();
  const since = Math.max(0, cursor - overlapMs);
  let after = null, newest = cursor, read = 0;
  for (;;) {
    const { docs, last } = await api.page(since, after);
    if (!docs.length) break;
    read += docs.length;
    await store.mergeRemote(docs);
    for (const d of docs) if (d.uMs > newest) newest = d.uMs;
    if (!last || docs.length < api.pageSize) break;
    after = last;
  }
  if (newest > cursor) await store.setCursor(newest);
  return read;
}

// '' when every local document exists remotely with an equal-or-newer revision.
export function cloudCovers(localDocs, remoteByRid) {
  for (const d of localDocs) {
    const r = remoteByRid.get(d.rid);
    if (!r) return `a ${d.kind === 'rank' ? 'page order' : d.kind.slice(0, -1)} isn't in your account yet`;
    if (cmpRev(revOf(r), revOf(d)) < 0) return `a ${d.kind === 'rank' ? 'page order' : d.kind.slice(0, -1)} in your account is older than on this phone`;
  }
  return '';
}
