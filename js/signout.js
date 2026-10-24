// Pure checks for Sign out: the local diary may only be wiped once Drive provably holds all of it.

import { mergeRecord, KINDS } from './merge.js';
import { cmpRev } from './rev.js';

// '' when the remote device file dominates the local snapshot under the full merge rule
// (merging the local record into the remote one changes nothing - rev and rankRev alike).
export function backupCovers(local, remote) {
  for (const kind of KINDS) {
    const byId = new Map((remote?.[kind] || []).map((r) => [r.id, r]));
    for (const r of local[kind] || []) {
      const rem = byId.get(r.id);
      if (!rem) return `a ${kind.slice(0, -1)} is missing from Drive`;
      const m = mergeRecord(rem, r);
      if (cmpRev(m.rev, rem.rev) !== 0 || cmpRev(m.rankRev, rem.rankRev) !== 0) return `a ${kind.slice(0, -1)} in Drive is older than on this phone`;
    }
  }
  return '';
}

// The review outbox is deliberately not a condition: intents live on the books (publicReview),
// which are in Drive, and the first sync after signing back in queues them again.
export function signOutReady({ online, mutationGen, syncedThroughGen, unsentDrawings }) {
  if (!online) return 'You\'re offline. Connect to the internet so everything can be saved to Drive first.';
  if (mutationGen !== syncedThroughGen) return 'Some changes aren\'t saved to Drive yet.';
  if (unsentDrawings > 0) return 'Some drawings aren\'t uploaded to Drive yet.';
  return '';
}
