import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseHandle, handleProblem, workIdOf, desiredReview, drainOutbox, averageOf } from '../js/social.js';

test('handles are normalised and validated like the rules do', () => {
  assert.equal(normaliseHandle('  @SudReads '), 'sudreads');
  assert.equal(handleProblem('ab'), 'At least 3 characters');
  assert.equal(handleProblem('a'.repeat(21)), 'At most 20 characters');
  assert.equal(handleProblem('has space'), 'Only a-z, 0-9 and _');
  assert.equal(handleProblem('sud_reads_17'), '');
});

test('work ids come only from Open Library work keys', () => {
  assert.equal(workIdOf('/works/OL45804W'), 'OL45804W');
  assert.equal(workIdOf('/books/OL1M'), null);
  assert.equal(workIdOf(''), null);
  assert.equal(workIdOf('/works/OL1W/../x'), null);
});

const book = (extra) => ({ id: 'b', olKey: '/works/OL1W', status: 'finished', publicReview: true, rating: 4, comment: 'Good', ...extra });

test('desired review: publish only finished, public, rated books with a work id', () => {
  assert.deepEqual(desiredReview(book()), { action: 'upsert', workId: 'OL1W', rating: 4, text: 'Good' });
  assert.equal(desiredReview(book({ publicReview: false })).action, 'delete');
  assert.equal(desiredReview(book({ publicReview: undefined })).action, 'delete'); // pre-1.2 books stay private
  assert.equal(desiredReview(book({ status: 'reading' })).action, 'delete');
  assert.equal(desiredReview(book({ deleted: true })).action, 'delete');
  assert.equal(desiredReview(book({ rating: 0 })).action, 'delete');
  assert.equal(desiredReview(book({ olKey: '' })).action, 'none');
  assert.equal(desiredReview(null).action, 'none');
  assert.equal(desiredReview(book({ comment: 'x'.repeat(2500) })).text.length, 2000);
});

test('outbox keeps an entry that changed while its write was in flight', async () => {
  const box = { b: 1 };
  let current = book();
  const calls = [];
  const api = {
    async upsertReview(w, r, t) { calls.push(['up', r]); current = book({ publicReview: false }); box.b = 2; }, // he flips it off mid-write
    async deleteReview(w) { calls.push(['del']); },
  };
  const ack = async (id, gen) => { if (box[id] === gen) { delete box[id]; return true; } return false; };
  const getBook = async () => current;
  assert.deepEqual(await drainOutbox({ entries: { ...box }, getBook, api, ack }), []);
  assert.deepEqual(box, { b: 2 });
  assert.deepEqual(await drainOutbox({ entries: { ...box }, getBook, api, ack }), ['b']);
  assert.deepEqual(calls, [['up', 4], ['del']]); // the newer intent (private) wins, never resurrected
  assert.deepEqual(box, {});
});

test('a failed write leaves the entry for the next pass', async () => {
  const box = { b: 1 };
  const api = { async upsertReview() { throw new Error('offline'); }, async deleteReview() {} };
  await assert.rejects(drainOutbox({ entries: { ...box }, getBook: async () => book(), api, ack: async () => true }), /offline/);
  assert.deepEqual(box, { b: 1 });
});

test('average of loaded reviews', () => {
  assert.equal(averageOf([]), 0);
  assert.equal(averageOf([{ rating: 5 }, { rating: 3 }]), 4);
});
