// Pure rules for the public layer (no Firebase imports), so they run under `node --test`.

import { bookKeyOf } from './catalog.js';

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
export const MAX_REVIEW = 2000;
export const REPORT_REASONS = { spam: 'Spam', mean: 'Mean or hateful', spoiler: 'Big spoiler', other: 'Something else' };

export function normaliseHandle(input) {
  return String(input || '').trim().replace(/^@/, '').toLowerCase();
}

export function handleProblem(h) {
  if (h.length < 3) return 'At least 3 characters';
  if (h.length > 20) return 'At most 20 characters';
  if (!HANDLE_RE.test(h)) return 'Only a-z, 0-9 and _';
  return '';
}

// "/works/OL123W" -> "OL123W". Anything else (hand-typed books, editions) has no public reviews.
export function workIdOf(olKey) {
  const m = /^\/works\/(OL\d{1,12}W)$/.exec(olKey || '');
  return m ? m[1] : null;
}

// What the remote review should be for this book right now. Only an explicit publicReview: true
// publishes, so books finished before 1.2 never go public by surprise. 2.0: keyed by the canonical
// book key (1.x books map from their Open Library work).
export function desiredReview(book) {
  const key = bookKeyOf(book);
  if (!key) return { action: 'none' };
  if (book && !book.deleted && book.status === 'finished' && book.publicReview === true && book.rating >= 1) {
    return { action: 'upsert', key, rating: Math.min(5, Math.round(book.rating)), text: String(book.comment || '').slice(0, MAX_REVIEW),
      book: { key, title: book.title || '', author: book.author || '', coverUrl: book.coverUrl || '', pages: book.totalPages || 0, isbn13: book.isbn13 || '' } };
  }
  return { action: 'delete', key };
}

// Drain the outbox serially. An entry is cleared only if nobody bumped it while its write was in
// flight; otherwise the next pass recomputes from the newer book record.
export async function drainOutbox({ entries, getBook, api, ack }) {
  const done = [];
  for (const [bookId, gen] of Object.entries(entries)) {
    const want = desiredReview(await getBook(bookId));
    if (want.action === 'upsert') await api.upsertReview(want.book, want.rating, want.text);
    else if (want.action === 'delete') await api.deleteReview(want.key);
    if (await ack(bookId, gen)) done.push(bookId);
  }
  return done;
}

export function averageOf(reviews) {
  if (!reviews.length) return 0;
  return reviews.reduce((n, r) => n + r.rating, 0) / reviews.length;
}
