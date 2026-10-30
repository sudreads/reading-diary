import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streak, farFromHome, awayRecord, awayDates, readingDates } from '../js/derive.js';
import { decideReminder } from '../js/reminder.js';

const read = (date) => ({ bookId: 'b', date, read: true });
const away = (date, extra) => ({ bookId: 'b', date, away: true, read: false, pages: 0, minutes: 0, ...extra });
const T = '2026-10-30';

test('away days hold the streak without adding to it', () => {
  const s = [read('2026-10-25'), read('2026-10-26'), away('2026-10-27'), away('2026-10-28'), away('2026-10-29'), away(T)];
  assert.equal(streak(s, T), 2);
  assert.equal(streak([...s, read(T)], T), 3); // reading on an away day still counts
});

test('the first morning back: today unread, yesterday away, streak still stands', () => {
  assert.equal(streak([read('2026-10-27'), away('2026-10-28'), away('2026-10-29')], T), 1);
});

test('a missed day that was not away still breaks it, and tombstoned away days do not hold it', () => {
  assert.equal(streak([read('2026-10-27'), away('2026-10-29')], T), 0);
  assert.equal(streak([read('2026-10-28'), away('2026-10-29', { deleted: true })], T), 0);
});

test('an unread day with no trip keeps the usual grace', () => {
  assert.equal(streak([read('2026-10-29')], T), 1);
});

test('away days are not reading days', () => {
  assert.equal(readingDates([away(T)]).size, 0);
  assert.equal(awayDates([away(T)]).size, 1);
});

test('limits: active, then 14 days of waiting from the last away day', () => {
  assert.deepEqual(farFromHome([], T), { until: null, nextAllowed: null, canStart: true });
  const s = [away('2026-11-02'), away('2026-11-01')];
  assert.equal(farFromHome(s, T).until, '2026-11-02');
  assert.equal(farFromHome(s, T).canStart, false);
  assert.equal(farFromHome(s, '2026-11-15').canStart, false);
  assert.equal(farFromHome(s, '2026-11-16').canStart, true);
  assert.equal(farFromHome(s, '2026-11-16').until, null);
});

test('the same date gives the same valid record id on every phone', () => {
  const a = awayRecord('b', '2026-11-02'), b = awayRecord('c', '2026-11-02');
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(a.id, awayRecord('b', '2026-11-03').id);
});

test('no reminder on an away day', () => {
  const now = new Date(2026, 9, 30, 18);
  assert.equal(decideReminder({ sessions: [away(T)], remindersOn: true, lastReminder: null, now }).why, 'away');
});
