import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRev, cmpRev } from '../js/rev.js';
import { rankBetween, compareRanked } from '../js/rank.js';
import { mergeRecord, mergeState } from '../js/merge.js';
import { streak, dayTotals, currentPage, lessonOfDay, addDays } from '../js/derive.js';
import { validateBackup, additiveRestore } from '../js/validate.js';
import { uuid } from './fakes.mjs';

const rec = (id, t, d, extra = {}) => ({ id, rev: { t, d }, ...extra });

test('rev never goes backwards even when the clock does', () => {
  const r1 = nextRev(0, 'a', 5000);
  const r2 = nextRev(r1.t, 'a', 10); // clock jumped back
  assert.ok(cmpRev(r2, r1) > 0);
});

test('cmpRev breaks equal times by device id', () => {
  assert.equal(cmpRev({ t: 1, d: 'a' }, { t: 1, d: 'b' }), -1);
  assert.equal(cmpRev({ t: 1, d: 'b' }, { t: 1, d: 'a' }), 1);
});

test('merge is commutative, associative and idempotent', () => {
  const A = { books: [rec('1', 5, 'a', { title: 'A5' }), rec('2', 1, 'a', { title: 'x' })] };
  const B = { books: [rec('1', 7, 'b', { title: 'B7' })], blocks: [rec('3', 2, 'b')] };
  const C = { books: [rec('2', 9, 'c', { deleted: true })] };
  const norm = (s) => JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, [...v].sort((x, y) => (x.id < y.id ? -1 : 1))])));
  assert.equal(norm(mergeState(A, B)), norm(mergeState(B, A)));
  assert.equal(norm(mergeState(mergeState(A, B), C)), norm(mergeState(A, mergeState(B, C))));
  const AB = mergeState(A, B);
  assert.equal(norm(mergeState(AB, AB)), norm(AB));
});

test('tombstone beats an older edit; a newer edit beats an older tombstone', () => {
  assert.equal(mergeRecord(rec('1', 1, 'a', { text: 'old' }), rec('1', 2, 'b', { deleted: true })).deleted, true);
  assert.equal(mergeRecord(rec('1', 3, 'a', { text: 'new' }), rec('1', 2, 'b', { deleted: true })).text, 'new');
});

test('a device with a clock years in the past still wins once it has seen newer revisions', () => {
  const seen = 2_000_000_000_000;
  const r = nextRev(seen, 'slow', 1_000_000);
  assert.ok(r.t > seen);
});

test('rank and content edits merge independently', () => {
  const base = rec('b', 1, 'a', { text: 'hi', rank: 'm', rankRev: { t: 1, d: 'a' } });
  const edited = { ...base, text: 'hello', rev: { t: 5, d: 'a' } };
  const moved = { ...base, rank: 'c', rankRev: { t: 4, d: 'b' } };
  for (const m of [mergeRecord(edited, moved), mergeRecord(moved, edited)]) {
    assert.equal(m.text, 'hello');
    assert.equal(m.rank, 'c');
  }
});

test('rankBetween always fits between and never ends in 0', () => {
  let keys = [rankBetween('', null)];
  for (let i = 0; i < 300; i++) {
    const j = i % (keys.length + 1);
    const k = rankBetween(keys[j - 1] || '', keys[j] ?? null);
    if (j > 0) assert.ok(keys[j - 1] < k);
    if (j < keys.length) assert.ok(k < keys[j]);
    assert.notEqual(k.at(-1), '0');
    keys.splice(j, 0, k);
  }
  const sorted = [...keys].sort();
  assert.deepEqual(sorted, keys);
  assert.ok(rankBetween('', '1') < '1');
  assert.equal(compareRanked({ rank: 'a', id: '2' }, { rank: 'a', id: '1' }), 1);
});

test('streak counts back from today, or from yesterday if today is not logged yet', () => {
  const s = (date, pages = 5) => ({ id: date + pages, date, pages, bookId: 'x' });
  const today = '2026-10-24';
  const sessions = [s(today), s(addDays(today, -1)), s(addDays(today, -2)), s(addDays(today, -4))];
  assert.equal(streak(sessions, today), 3);
  assert.equal(streak(sessions.slice(1), today), 2);
  assert.equal(streak([...sessions, { ...s(addDays(today, -3)), deleted: true }], today), 3);
  assert.equal(streak([{ ...s(today, 0), minutes: 0 }], today), 0);
});

test('day totals and current page come from sessions, ignoring deleted ones', () => {
  const ss = [
    { id: '1', bookId: 'b', date: 'd', pages: 10, minutes: 15, toPage: 40 },
    { id: '2', bookId: 'b', date: 'd', pages: 5, minutes: 5, toPage: 45 },
    { id: '3', bookId: 'b', date: 'd', pages: 99, toPage: 300, deleted: true },
  ];
  assert.deepEqual(dayTotals(ss, 'd'), { pages: 15, minutes: 20 });
  assert.equal(currentPage('b', ss), 45);
});

test('lesson of the day is stable for a date and skips deleted lessons', () => {
  const blocks = [
    { id: 'a', type: 'lesson', text: 'one' }, { id: 'b', type: 'lesson', text: 'two' },
    { id: 'c', type: 'lesson', text: 'gone', deleted: true }, { id: 'd', type: 'text', text: 'note' },
  ];
  const l = lessonOfDay(blocks, '2026-10-24');
  assert.equal(lessonOfDay([...blocks].reverse(), '2026-10-24').id, l.id);
  assert.ok(['a', 'b'].includes(l.id));
  assert.equal(lessonOfDay([], '2026-10-24'), null);
});

const goodBackup = () => {
  const book = uuid();
  return {
    app: 'reading-diary', schemaVersion: 1,
    books: [{ id: book, rev: { t: 100, d: 'x' }, title: 'Make Your Bed', status: 'finished', rating: 5, coverUrl: 'https://covers.openlibrary.org/b/id/1-M.jpg' }],
    blocks: [{ id: uuid(), rev: { t: 100, d: 'x' }, bookId: book, type: 'lesson', text: 'Start small', rank: 'i', rankRev: { t: 100, d: 'x' } }],
    sessions: [{ id: uuid(), rev: { t: 100, d: 'x' }, bookId: book, date: '2026-10-01', pages: 10 }],
    drawings: [],
  };
};

test('restore validation accepts a good backup', () => {
  const v = validateBackup(goodBackup(), { maxT: 1000 });
  assert.deepEqual(v.errors, []);
  assert.equal(v.data.books.length, 1);
});

test('restore validation rejects future revisions, bad URLs, oversize drawings and junk', () => {
  const b = goodBackup();
  b.books.push({ ...b.books[0], id: uuid(), rev: { t: 5000, d: 'x' } });
  b.books.push({ ...b.books[0], id: uuid(), coverUrl: 'javascript:alert(1)' });
  b.books.push({ ...b.books[0], id: uuid(), coverUrl: 'https://evil.example/x.jpg' });
  b.books.push({ ...b.books[0], id: 'not-a-uuid' });
  b.drawings.push({ id: uuid(), webp: 'A'.repeat(3 * 1024 * 1024) });
  const v = validateBackup(b, { maxT: 1000 });
  assert.equal(v.data.books.length, 1);
  assert.equal(v.data.drawings.length, 0);
  assert.equal(v.errors.length, 5);
  assert.equal(validateBackup({ app: 'other' }, { maxT: 1 }).ok, false);
  assert.equal(validateBackup(null, { maxT: 1 }).ok, false);
});

test('restore never changes an existing id, live or deleted', () => {
  const b = goodBackup();
  const local = { books: [{ ...b.books[0], title: 'Mine', deleted: true, rev: { t: 1, d: 'me' } }], blocks: [], sessions: [] };
  const add = additiveRestore(local, b);
  assert.equal(add.books.length, 0);
  assert.equal(add.blocks.length, 1);
  assert.equal(add.sessions.length, 1);
});

test('restore validation rejects ranks outside the fractional-index alphabet', () => {
  const b = goodBackup();
  b.blocks.push({ ...b.blocks[0], id: uuid(), rank: 'ZZ!' });
  b.blocks.push({ ...b.blocks[0], id: uuid(), rank: 'a0' });
  const v = validateBackup(b, { maxT: 1000 });
  assert.equal(v.data.blocks.length, 1);
  assert.equal(validateBackup({ app: 'reading-diary', schemaVersion: 9 }, { maxT: 1 }).fatal, true);
});
