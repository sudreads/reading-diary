import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideReminder, reminderText } from '../js/reminder.js';

const at = (h, m = 0) => new Date(2026, 9, 27, h, m);
const read = (date) => ({ id: date, bookId: 'b', date, read: true });

test('reminds in the afternoon when you have not read today, with yesterday\'s streak', () => {
  const d = decideReminder({ sessions: [read('2026-10-26'), read('2026-10-25')], remindersOn: true, lastReminder: null, now: at(17) });
  assert.equal(d.send, true);
  assert.equal(d.streak, 2);
  assert.equal(d.today, '2026-10-27');
});

test('stays quiet if you already read, already got one today, switched it off, or it is night', () => {
  const base = { sessions: [read('2026-10-26')], remindersOn: true, lastReminder: null, now: at(17) };
  assert.equal(decideReminder({ ...base, sessions: [read('2026-10-27')] }).why, 'read-today');
  assert.equal(decideReminder({ ...base, lastReminder: '2026-10-27' }).why, 'already-today');
  assert.equal(decideReminder({ ...base, remindersOn: false }).why, 'off');
  assert.equal(decideReminder({ ...base, now: at(23) }).why, 'night');
  assert.equal(decideReminder({ ...base, now: at(7, 59) }).why, 'night');
  assert.equal(decideReminder({ ...base, now: at(22, 29) }).send, true);
  // a deleted check-in doesn't count as reading
  assert.equal(decideReminder({ ...base, sessions: [{ ...read('2026-10-27'), deleted: true }] }).send, true);
});

test('lock-screen text never mentions the book', () => {
  assert.match(reminderText(5).title, /5-day streak/);
  assert.equal(reminderText(0).title, '📖 Time to read');
});
