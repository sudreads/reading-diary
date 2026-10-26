# Plan: Reading Diary 2.1 - reading reminders without a server
_2026-10-27. Yanai chose the no-server option knowing Chrome decides the timing._

## Goal
If he hasn't read today, his phone shows a reminder ("🔥 Keep your 12-day streak - time to read!")
about once a day. No backend: Chrome's Periodic Background Sync wakes the installed app's service
worker; Chrome picks when (roughly daily, depending on how much he uses the app).

## Design
1. **Me -> Reminders card:** a switch. Turning it on: request notification permission (user tap),
   check `'periodicSync' in registration` and the `periodic-background-sync` permission, then
   `registration.periodicSync.register('read-reminder', { minInterval: 12 h })`. Off:
   `unregister('read-reminder')`. Status line explains the real state: on / "install the app to
   your home screen first" / "notifications are blocked in phone settings" / "this browser can't".
   A "Send a test reminder" button shows one notification now (proves permission).
   The choice is stored in the diary's local meta (`remindersOn`), not synced.
2. **Service worker `periodicsync` (tag read-reminder):** open the existing `reading-diary`
   IndexedDB read-only, **never creating it** (if `onupgradeneeded` fires the DB didn't exist: abort,
   do nothing). Read `sessions`, `books`, `meta`. Skip if: `remindersOn` false; today (local date)
   already has a reading session (read:true, or pages/minutes > 0, not deleted); a reminder was
   already shown today (`lastReminder` in meta - the only write); local time outside 09:00-21:30
   (Chrome may wake it at night). Otherwise show the notification (streak from consecutive days
   ending yesterday; book title of the current "reading" book) with `tag: 'read-reminder'` so it
   replaces rather than stacks. Writes `lastReminder = today` in the same pass.
3. **Notification click:** focus an open app window or open `./`.
4. Same day logic as the app (local YYYY-MM-DD, same "counts as read" rule).
5. SW cache bumped; nothing else in the SW changes.

## Limits (told to the user in the card)
Android Chrome, installed app only; timing not chosen by us; won't fire if the phone is in deep
battery saver; never fires at night; at most one reminder per day.
