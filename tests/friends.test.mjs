import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityCard } from '../js/activity.js';

const book = (id, extra) => ({ id, title: `Book ${id}`, coverUrl: 'https://covers.openlibrary.org/b/id/1-M.jpg', olKey: '/works/OL1W', rev: { t: 1, d: 'a' }, ...extra });

test('the activity card shares only streak, reading now, finished count and last finished', () => {
  const card = activityCard({
    handle: 'sud', today: '2026-10-27',
    books: [book('a', { status: 'reading', startedAt: '2026-10-20' }), book('b', { status: 'finished', finishedAt: '2026-10-10', rating: 5, comment: 'private thoughts' }),
      book('c', { status: 'finished', finishedAt: '2026-09-01', rating: 3 }), book('d', { status: 'finished', deleted: true })],
    sessions: [{ id: 's1', bookId: 'a', date: '2026-10-27', read: true }, { id: 's2', bookId: 'a', date: '2026-10-26', read: true }],
  });
  assert.deepEqual(Object.keys(card).sort(), ['currentBook', 'finishedCount', 'handle', 'lastFinished', 'streak']);
  assert.equal(card.streak, 2);
  assert.equal(card.finishedCount, 2);
  assert.equal(card.currentBook.title, 'Book a');
  assert.equal(card.lastFinished.title, 'Book b');
  assert.equal(card.lastFinished.rating, 5);
  assert.equal(JSON.stringify(card).includes('private thoughts'), false);
});

test('unsafe covers are dropped and nothing reading is null', () => {
  const card = activityCard({ handle: 'sud', today: '2026-10-27', books: [book('a', { status: 'finished', finishedAt: '2026-10-01', coverUrl: 'https://evil.example/x.jpg' })], sessions: [] });
  assert.equal(card.currentBook, null);
  assert.equal(card.lastFinished.coverUrl, '');
  assert.equal(card.streak, 0);
});

test('a friend who stopped opening the app shows their streak as lapsed', async () => {
  const { liveStreak } = await import('../js/activity.js');
  const at = (d) => new Date(`${d}T12:00:00`).getTime();
  assert.equal(liveStreak({ streak: 7, updatedAt: at('2026-10-27') }, '2026-10-27'), 7);
  assert.equal(liveStreak({ streak: 7, updatedAt: at('2026-10-26') }, '2026-10-27'), 7); // can still read today
  assert.equal(liveStreak({ streak: 7, updatedAt: at('2026-10-25') }, '2026-10-27'), 0);
  assert.equal(liveStreak({ streak: 7, updatedAt: 0 }, '2026-10-27'), 0);
});
