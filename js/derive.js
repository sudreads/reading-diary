// Everything shown on screen that is computed rather than stored.

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}

const live = (list) => list.filter((r) => !r.deleted);

// A day counts once a reading session finished (read: true; 2.0-2.2 also by tapping "I read today") or, for 1.0 data, logged pages or minutes.
export function readingDates(sessions) {
  return new Set(live(sessions).filter((s) => s.read === true || (s.pages || 0) > 0 || (s.minutes || 0) > 0).map((s) => s.date));
}

// Far from home: days chosen ahead that keep the streak without adding to it.
export function awayDates(sessions) {
  return new Set(live(sessions).filter((s) => s.away === true).map((s) => s.date));
}

export const AWAY_MAX_DAYS = 14; // longest trip
export const AWAY_COOLDOWN_DAYS = 14; // first new start = last away day + this

// Works on the set of dates, so trips started on two offline phones still read sensibly.
export function farFromHome(sessions, today = localDate()) {
  const last = [...awayDates(sessions)].sort().at(-1);
  if (!last) return { until: null, nextAllowed: null, canStart: true };
  const nextAllowed = addDays(last, AWAY_COOLDOWN_DAYS);
  return { until: last >= today ? last : null, nextAllowed, canStart: today >= nextAllowed };
}

// One fixed id per date, so the same day from two phones is one record and "back early" clears it everywhere.
export function awayRecord(bookId, date) {
  return { id: `f4f4f4f4-0000-4000-8000-0000${date.replace(/-/g, '')}`, bookId, date, away: true, read: false, pages: 0, minutes: 0, deleted: false };
}

// Consecutive days with reading, ending today - or yesterday, since today is not over yet.
// Away days are stepped over without counting.
export function streak(sessions, today = localDate()) {
  const dates = readingDates(sessions), away = awayDates(sessions);
  let day = dates.has(today) || away.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (dates.has(day) || away.has(day)) { if (dates.has(day)) n++; day = addDays(day, -1); }
  return n;
}

export function dayTotals(sessions, date) {
  let pages = 0, minutes = 0;
  for (const s of live(sessions)) if (s.date === date) { pages += s.pages || 0; minutes += s.minutes || 0; }
  return { pages, minutes };
}

export function currentPage(bookId, sessions) {
  let page = 0;
  for (const s of live(sessions)) if (s.bookId === bookId && (s.toPage || 0) > page) page = s.toPage;
  return page;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Same lesson all day, on every device.
export function lessonOfDay(blocks, date = localDate()) {
  const lessons = live(blocks).filter((b) => (b.type === 'lesson' || (b.type === 'comment' && b.lesson === true)) && (b.text || '').trim())
    .sort((x, y) => (x.id < y.id ? -1 : 1));
  if (!lessons.length) return null;
  return lessons[hash(date) % lessons.length];
}
