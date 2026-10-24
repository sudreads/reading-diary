import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupePlan } from '../js/dedupe.js';

const book = (id, extra = {}) => ({ id, title: 'Rich Dad Poor Dad', author: 'Robert T. Kiyosaki', olKey: '/works/OL1W', status: 'reading', rev: { t: 1, d: 'a' }, ...extra });
const page = (bookId, text = 'notes') => ({ id: `p-${bookId}`, bookId, type: 'page', text });

test('removes the empty copy and keeps the one with writing', () => {
  const plan = dedupePlan([book('empty'), book('mine', { rev: { t: 0, d: 'a' } })], [page('mine')]);
  assert.deepEqual(plan.remove, ['empty']);
  assert.deepEqual(plan.moveSessions, [{ from: 'empty', to: 'mine' }]);
});

test('never removes a copy that has writing, a rating or a review', () => {
  assert.deepEqual(dedupePlan([book('a'), book('b')], [page('a'), page('b')]).remove, []);
  assert.deepEqual(dedupePlan([book('a', { rating: 4 }), book('b')], [page('b')]).remove, []);
  assert.deepEqual(dedupePlan([book('a', { comment: 'loved it' }), book('b')], [page('b')]).remove, []);
});

test('leaves all-empty duplicates alone (nothing says which to keep)', () => {
  assert.deepEqual(dedupePlan([book('a'), book('b')], []).remove, []);
});

test('different books, deleted copies and deleted pages are handled correctly', () => {
  assert.deepEqual(dedupePlan([book('a'), book('b', { olKey: '/works/OL2W', title: 'Make Your Bed' })], [page('b')]).remove, []);
  assert.deepEqual(dedupePlan([book('a', { deleted: true }), book('b')], [page('b')]).remove, []);
  // a deleted page doesn't count as writing, so that copy is empty
  assert.deepEqual(dedupePlan([book('a'), book('b')], [{ ...page('a'), deleted: true }, page('b')]).remove, ['a']);
});

test('a blank page does not count as writing; a drawing does', () => {
  assert.deepEqual(dedupePlan([book('a'), book('b')], [page('a', '   '), page('b')]).remove, ['a']);
  assert.deepEqual(dedupePlan([book('a'), book('b')], [{ ...page('a', ''), drawingId: 'd1' }, page('b')]).remove, []);
});

test('hand-typed duplicates match by title and author', () => {
  const plan = dedupePlan([book('a', { olKey: '', title: ' rich dad  POOR dad' }), book('b', { olKey: '' })], [page('b')]);
  assert.deepEqual(plan.remove, ['a']);
});

test('the kept copy becomes "reading" if the removed empty one was the current book', () => {
  const plan = dedupePlan([book('empty', { status: 'reading' }), book('mine', { status: 'want' })], [page('mine')]);
  assert.deepEqual(plan.setStatus, [{ id: 'mine', status: 'reading' }]);
  const finished = dedupePlan([book('empty', { status: 'reading' }), book('mine', { status: 'finished' })], [page('mine')]);
  assert.deepEqual(finished.setStatus, []);
});
