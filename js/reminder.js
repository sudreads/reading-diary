// The reading-reminder decision, shared by the service worker and the tests.
import { readingDates, awayDates, streak, localDate } from './derive.js';

export const QUIET_FROM = 22.5; // 22:30
export const QUIET_UNTIL = 8;   // 08:00

// -> { send: false } or { send: true, today, streak }
export function decideReminder({ sessions, remindersOn, lastReminder, now = new Date() }) {
  const hour = now.getHours() + now.getMinutes() / 60;
  if (hour < QUIET_UNTIL || hour >= QUIET_FROM) return { send: false, why: 'night' };
  if (!remindersOn) return { send: false, why: 'off' };
  const today = localDate(now);
  if (lastReminder === today) return { send: false, why: 'already-today' };
  if (readingDates(sessions).has(today)) return { send: false, why: 'read-today' };
  if (awayDates(sessions).has(today)) return { send: false, why: 'away' };
  return { send: true, today, streak: streak(sessions, today) };
}

// Generic on purpose: lock screens are visible to anyone holding the phone.
export function reminderText(streakDays) {
  return streakDays
    ? { title: `🔥 Keep your ${streakDays}-day streak going`, body: "You haven't read today yet - a 5-minute reading session is enough." }
    : { title: '📖 Time to read', body: 'A 5-minute reading session today starts a streak.' };
}
