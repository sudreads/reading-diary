import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideReminder, reminderText } from '../js/reminder.js';
import { streak } from '../js/derive.js';

const src = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('sw.js stays a classic worker (2.0 phones registered it as one)', () => {
  assert.doesNotMatch(src, /^\s*(import|export)\b/m);
  assert.doesNotThrow(() => new Function(src.replace(/self\.\w+/g, '({addEventListener(){}, registration:{}, clients:{}})')));
});

test("sw.js's copy of the reminder logic agrees with the app's", () => {
  const block = src.slice(src.indexOf('// ---- BEGIN copy'), src.indexOf('// ---- END copy'));
  const sw = new Function(`${block}; return { decideReminder, reminderText, streak };`)();
  const s = (date, extra) => ({ bookId: 'b', date, ...extra });
  const cases = [
    { sessions: [], remindersOn: true, lastReminder: null, now: new Date(2026, 9, 27, 18) },
    { sessions: [s('2026-10-26', { read: true }), s('2026-10-25', { minutes: 5 })], remindersOn: true, lastReminder: null, now: new Date(2026, 9, 27, 18) },
    { sessions: [s('2026-10-27', { read: true })], remindersOn: true, lastReminder: null, now: new Date(2026, 9, 27, 18) },
    { sessions: [], remindersOn: true, lastReminder: '2026-10-27', now: new Date(2026, 9, 27, 18) },
    { sessions: [], remindersOn: false, lastReminder: null, now: new Date(2026, 9, 27, 18) },
    { sessions: [], remindersOn: true, lastReminder: null, now: new Date(2026, 9, 27, 23) },
    { sessions: [s('2026-10-26', { read: true, deleted: true })], remindersOn: true, lastReminder: null, now: new Date(2026, 9, 27, 9) },
  ];
  for (const c of cases) assert.deepEqual(sw.decideReminder(c), decideReminder(c));
  for (const n of [0, 1, 7]) assert.deepEqual(sw.reminderText(n), reminderText(n));
  assert.equal(sw.streak(cases[1].sessions, '2026-10-27'), streak(cases[1].sessions, '2026-10-27'));
});
