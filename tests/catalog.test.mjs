import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookKeyOf, isBookKey, mergeResults, safeCover } from '../js/catalog.js';

test('book keys: 2.0 bookKey wins, 1.x books map from their Open Library work', () => {
  assert.equal(bookKeyOf({ bookKey: 'isbn:9781612680194' }), 'isbn:9781612680194');
  assert.equal(bookKeyOf({ olKey: '/works/OL45804W' }), 'ol:OL45804W');
  assert.equal(bookKeyOf({ olKey: '/books/OL1M' }), null);
  assert.equal(bookKeyOf({ bookKey: 'evil', olKey: '' }), null);
  assert.ok(isBookKey('gb:zyTCAlFPjgYC'));
  assert.ok(isBookKey('c:0b9a6c1e-3f4d-4a5b-8c7d-9e0f1a2b3c4d'));
  assert.ok(!isBookKey('isbn:123'));
  assert.ok(!isBookKey('ol:OL1W/../x'));
});

test('search results: the same book from two sources is shown once, first source wins', () => {
  const g = { key: 'isbn:9781612680194', title: 'Rich Dad Poor Dad', author: 'Robert T. Kiyosaki' };
  const o = { key: 'ol:OL1W', title: 'Rich Dad, Poor Dad', author: 'Robert T. Kiyosaki' };
  const other = { key: 'ol:OL2W', title: 'Make Your Bed', author: 'William H. McRaven' };
  assert.deepEqual(mergeResults([[g], [o, other]]).map((b) => b.key), ['isbn:9781612680194', 'ol:OL2W']);
});

test('covers only from the allowed hosts', () => {
  assert.equal(safeCover('https://books.google.com/books/content?id=x'), 'https://books.google.com/books/content?id=x');
  assert.equal(safeCover('https://covers.openlibrary.org/b/id/1-M.jpg'), 'https://covers.openlibrary.org/b/id/1-M.jpg');
  assert.equal(safeCover('https://evil.example/x.jpg'), '');
  assert.equal(safeCover('javascript:alert(1)'), '');
});
