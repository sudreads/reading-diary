import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupCovers, signOutReady } from '../js/signout.js';

const rec = (id, t, extra = {}) => ({ id, rev: { t, d: 'a' }, ...extra });

test('backup covers the diary when every record is in Drive at the same or newer revision', () => {
  const local = { books: [rec('b1', 5)], blocks: [rec('k1', 3, { rank: 'i', rankRev: { t: 3, d: 'a' } })], sessions: [rec('s1', 2, { deleted: true })] };
  const remote = { books: [rec('b1', 7)], blocks: [rec('k1', 3, { rank: 'i', rankRev: { t: 3, d: 'a' } })], sessions: [rec('s1', 2, { deleted: true })] };
  assert.equal(backupCovers(local, remote), '');
});

test('a missing record, an older record, or an older block order all refuse', () => {
  const local = { books: [rec('b1', 5)], blocks: [], sessions: [] };
  assert.match(backupCovers(local, { books: [], blocks: [], sessions: [] }), /missing/);
  assert.match(backupCovers(local, { books: [rec('b1', 4)], blocks: [], sessions: [] }), /older/);
  const block = rec('k1', 3, { rank: 'c', rankRev: { t: 9, d: 'a' } }); // reordered after the upload
  const stale = rec('k1', 3, { rank: 'i', rankRev: { t: 3, d: 'a' } });
  assert.match(backupCovers({ blocks: [block] }, { blocks: [stale] }), /older/);
  assert.match(backupCovers({ sessions: [rec('s1', 2)] }, null), /missing/);
});

test('sign-out readiness names the first thing blocking it', () => {
  const ok = { online: true, mutationGen: 4, syncedThroughGen: 4, unsentDrawings: 0, outboxSize: 0 };
  assert.equal(signOutReady(ok), '');
  assert.match(signOutReady({ ...ok, online: false }), /offline/);
  assert.match(signOutReady({ ...ok, syncedThroughGen: 3 }), /aren't saved/);
  assert.match(signOutReady({ ...ok, unsentDrawings: 1 }), /drawings/);
  assert.equal(signOutReady({ ...ok, outboxSize: 2 }), ''); // reviews are re-queued after the next sign-in
});
