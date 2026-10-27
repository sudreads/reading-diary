// The small card friends see: streak, reading now, finished count, last finished. Pure, so it can be tested.

import { streak, localDate, addDays } from './derive.js';
import { bookKeyOf, safeCover } from './catalog.js';

const bookHint = (b) => ({ key: String(bookKeyOf(b) || '').slice(0, 80), title: String(b.title || '').slice(0, 300), coverUrl: safeCover(b.coverUrl) });
const newest = (list, field) => [...list].sort((a, b) => String(b[field] || '').localeCompare(String(a[field] || '')) || (b.rev?.t || 0) - (a.rev?.t || 0))[0];

export function activityCard({ handle, books, sessions, today = localDate() }) {
  const live = books.filter((b) => !b.deleted);
  const reading = newest(live.filter((b) => b.status === 'reading'), 'startedAt');
  const finished = live.filter((b) => b.status === 'finished');
  const last = newest(finished, 'finishedAt');
  return {
    handle,
    currentBook: reading ? bookHint(reading) : null,
    streak: Math.min(100000, streak(sessions, today)),
    finishedCount: Math.min(100000, finished.length),
    lastFinished: last ? { ...bookHint(last), rating: Math.max(0, Math.min(5, Math.round(last.rating || 0))) } : null,
  };
}

// A card is a snapshot from the friend's last visit: if they haven't opened the app since
// yesterday, their streak has lapsed even though the card still says otherwise.
export function liveStreak(card, today = localDate()) {
  return card.updatedAt && localDate(new Date(card.updatedAt)) >= addDays(today, -1) ? card.streak : 0;
}
