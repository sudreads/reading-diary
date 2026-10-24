import { cmpRev } from './rev.js';

export const KINDS = ['books', 'blocks', 'sessions'];

// Higher rev wins the record; rank/rankRev are merged on their own so a reorder on one device
// and a text edit on another both survive. Commutative, associative and idempotent.
export function mergeRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...(cmpRev(a.rev, b.rev) >= 0 ? a : b) };
  if (a.rankRev || b.rankRev) {
    const r = cmpRev(a.rankRev, b.rankRev) >= 0 ? a : b;
    out.rank = r.rank;
    out.rankRev = r.rankRev;
  }
  return out;
}

export function mergeList(a = [], b = []) {
  const byId = new Map();
  for (const r of a) byId.set(r.id, r);
  for (const r of b) byId.set(r.id, mergeRecord(byId.get(r.id), r));
  return [...byId.values()];
}

export function mergeState(a = {}, b = {}) {
  const out = {};
  for (const k of KINDS) out[k] = mergeList(a[k], b[k]);
  return out;
}

export function sameRecord(a, b) {
  return !!a && !!b && cmpRev(a.rev, b.rev) === 0 && cmpRev(a.rankRev, b.rankRev) === 0;
}
