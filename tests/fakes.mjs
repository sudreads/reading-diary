// In-memory stand-ins for IndexedDB and Google Drive. Every call awaits a seeded random delay
// so concurrent devices interleave differently on each seed.

import { mergeRecord, KINDS } from '../js/merge.js';
import { nextRev, maxT } from '../js/rev.js';

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

const tick = (rand) => new Promise((r) => setTimeout(r, Math.floor(rand() * 3)));

let idn = 0;
export const uuid = () => {
  const h = (++idn).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
};

export function fakeDrive(rand) {
  const files = new Map(); // id -> {name, modifiedTime, body}
  let clock = 0, nid = 0;
  return {
    files,
    async listDeviceFiles() { await tick(rand); return [...files].filter(([, f]) => f.name.startsWith('device-')).map(([id, f]) => ({ id, name: f.name, modifiedTime: f.modifiedTime })); },
    async downloadJson(id) { await tick(rand); return JSON.parse(files.get(id).body); },
    async uploadDeviceFile(id, name, obj) {
      await tick(rand);
      if (!id) id = `f${++nid}`;
      const f = { name, modifiedTime: String(++clock), body: JSON.stringify(obj) };
      files.set(id, f);
      return { id, modifiedTime: f.modifiedTime };
    },
    async getFileMeta(id) { await tick(rand); const f = files.get(id); return f ? { id, modifiedTime: f.modifiedTime } : null; },
    async ensureDrawing(name, blob) {
      await tick(rand);
      if (![...files.values()].some((f) => f.name === name)) files.set(`f${++nid}`, { name, modifiedTime: String(++clock), body: blob });
    },
  };
}

export function fakeStore(deviceId, rand) {
  const data = { books: new Map(), blocks: new Map(), sessions: new Map() };
  const meta = new Map([['mutationGen', 0], ['highestT', 0]]);
  const drawings = new Map();
  let wall = 1000;
  const store = {
    deviceId, data, meta, drawings,
    setWall(t) { wall = t; },
    async getMeta(k, d) { await tick(rand); return meta.has(k) ? structuredClone(meta.get(k)) : d; },
    async setMeta(k, v) { await tick(rand); meta.set(k, structuredClone(v)); },
    async mergeIn(state) {
      await tick(rand);
      for (const k of KINDS) for (const r of state[k] || []) data[k].set(r.id, mergeRecord(data[k].get(r.id), r));
      const all = KINDS.flatMap((k) => state[k] || []);
      meta.set('highestT', Math.max(meta.get('highestT'), maxT(all)));
    },
    async snapshot() { await tick(rand); const o = {}; for (const k of KINDS) o[k] = structuredClone([...data[k].values()]); return o; },
    async pendingDrawings() { await tick(rand); return [...drawings].filter(([, d]) => !d.uploaded).map(([id, d]) => ({ id, blob: d.blob })); },
    async markDrawingUploaded(id) { await tick(rand); drawings.get(id).uploaded = true; },
    // Synchronous local edit, like one IndexedDB transaction: stamp rev, bump gen.
    write(kind, rec, { rankOnly = false } = {}) {
      const rev = nextRev(meta.get('highestT'), deviceId, wall++);
      meta.set('highestT', rev.t);
      const prev = data[kind].get(rec.id) || {};
      const next = rankOnly ? { ...prev, rank: rec.rank, rankRev: rev } : { ...prev, ...rec, rev };
      if (!rankOnly && rec.rank !== undefined) next.rankRev = rev;
      data[kind].set(rec.id, next);
      meta.set('mutationGen', meta.get('mutationGen') + 1);
      return next;
    },
  };
  return store;
}
