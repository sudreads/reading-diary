# Plan: 2.3 Reading session timer
_Locked with Yanai 2026-10-27 (interview). Reviewed via claudex-loop._

## Goal
"I read today" is a self-reported tap people can lie about. Replace it with a 5-minute
in-app reading session: the day (and streak) counts only if the timer reaches 0:00 while the
reader stays in the app.

## Approach
1. New module `js/session.js`:
   - Pure `createTimer({ durationMs, now })` state machine (testable in node): `start()`,
     `pause()`, `resume()`, `remaining()`, `elapsed()`, `done()`. Time is computed from
     timestamps (`now()`), never by counting ticks, so throttled intervals can't slow or
     speed it.
   - `readingSession(book, { onComplete, onOpenNotebook, cover })` - full-screen overlay
     (reuses `.checkin-screen` look): book cover, big mm:ss countdown, **Stop** button.
     Repaints every 250 ms with setInterval.
   - Wake lock: `navigator.wakeLock.request('screen')` on start. If it succeeds the screen
     won't auto-sleep, so any `visibilitychange -> hidden` is a deliberate leave -> session
     FAILS ("Session stopped - you left the app. Today isn't counted yet."). If wake lock is
     unsupported or rejected -> `hidden` PAUSES the timer and `visible` resumes it (the
     paused time does not count). Wake lock is also released by the browser on hide; on
     resume (fallback mode) re-request it.
   - Stop before 0:00 -> confirm ("Stop now? Today won't count.") -> close, nothing saved.
   - At 0:00: `onComplete()` saves the day, overlay switches to a done state: "🔥 N day
     streak", confetti, buttons **Open notebook** and **Keep going**.
   - Keep going: timer counts up from 5:00 with a **Done** button (same leave rules: with
     wake lock, leaving just ends keep-going and keeps what was read; in fallback it pauses).
     Done/leave updates that session record's `minutes` to the whole minutes read.
   - Single instance guard: a second start while one is open is ignored. Wake lock and
     listeners are always released on close.
2. `js/app.js`:
   - All three "I read today" buttons (check-in screen, current-book card, "Not yet" state)
     become **Start reading session** and open `readingSession`.
   - `readTodayClick` becomes `completeSession(book)`: re-check today isn't already counted
     (another tab), `store.save('sessions', { bookId, date: localDate() at completion,
     read: true, pages: 0, minutes: 5 })`, return the record id + new streak.
   - While a session overlay is open: `maybeCheckin` must not open over it, and the
     visibilitychange render must not run (busy guard / `sessionOpen` flag).
   - Undo on the "You read today" line stays (it can only lower your own streak).
3. No data-shape change: sessions already have `read`, `minutes` (validator allows 0..1440).
   Old days stay counted. `readingDates`/`streak` unchanged.
4. CSS for the timer screen; sw cache bump `rd-v14`, add `js/session.js`; VERSION 2.3.0.
5. Reminder copy ("tap when you've read") updated to session wording.

## Key decisions & tradeoffs
- Wake lock present -> leaving fails; absent -> pause (Yanai's explicit rule). We cannot
  tell a manual power-button press from an app switch; both fail when wake lock is on.
- Anti-cheat is honor-plus-friction, not proof: someone can sit idle 5 minutes. Accepted.
- Client-only: a determined user can edit IndexedDB. Accepted (no server, Spark plan).
- Session that crosses midnight counts for the date at completion.
- Timer is not persisted across reloads: a reload mid-session simply loses it.

## Out of scope
Configurable duration, per-session history UI, friend-visible minutes.
