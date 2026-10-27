import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimer, clock, SESSION_MS } from '../js/session.js';

test('the timer counts only while running, from the clock not from ticks', () => {
  let t = 1000;
  const timer = createTimer({ now: () => t });
  assert.equal(timer.elapsed(), 0);
  timer.start(); t += 60_000;
  assert.equal(timer.elapsed(), 60_000);
  timer.pause(); t += 10 * 60_000; // away from the app: doesn't count
  assert.equal(timer.elapsed(), 60_000);
  timer.start(); timer.start(); t += 4 * 60_000; // a second start doesn't reset
  assert.equal(timer.elapsed(), SESSION_MS);
  timer.pause(); timer.pause();
  assert.equal(timer.elapsed(), SESSION_MS);
});

test('the clock shows m:ss and never goes negative', () => {
  assert.equal(clock(SESSION_MS), '5:00');
  assert.equal(clock(61_000), '1:01');
  assert.equal(clock(400), '0:01'); // never 0:00 while the session is still running
  assert.equal(clock(-500), '0:00');
  assert.equal(clock(75 * 60_000), '75:00');
});
