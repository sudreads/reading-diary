// Revisions: a hybrid-logical-clock stamp {t, d}. t never goes backwards on a device even if
// the phone clock does, and d (the device id) breaks ties, so every comparison is decisive.

export function nextRev(highestT, deviceId, now = Date.now()) {
  return { t: Math.max(now, (highestT || 0) + 1), d: deviceId };
}

export function cmpRev(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.d === b.d) return 0;
  return a.d < b.d ? -1 : 1;
}

export function maxT(records) {
  let m = 0;
  for (const r of records) {
    if (r.rev && r.rev.t > m) m = r.rev.t;
    if (r.rankRev && r.rankRev.t > m) m = r.rankRev.t;
  }
  return m;
}
