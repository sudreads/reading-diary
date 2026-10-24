# Plan: Reading Diary 1.3 - sign-in first, daily check-in first
_2026-10-24, from Yanai's request. Builds on PLAN-v1.2.md._

## Requests
1. You can't use the app until you're signed in.
2. Once signed in, if you haven't read today, the first screen is "Did you read today?" with
   **I read today** / **Not yet**. Yes -> streak continues. Not yet -> you go into the app and the
   streak does not continue for today.

## Design
1. **Sign-in gate.** On boot, if Firebase is configured and `meta.ownerUid` is empty, show a
   full-screen welcome with one "Sign in with Google" button instead of the app (no tab bar, no
   diary data rendered). The button runs the existing interactive sign-in (GIS -> Drive check ->
   Firebase credential -> bindAccount, which sets ownerUid). Errors (not a beta tester, popup
   closed, offline) are shown on the gate with a retry. Once ownerUid is set the gate lifts and the
   existing handle sheet appears if needed.
   - **Offline / local-first:** the gate checks only the local `ownerUid`, never the network, so a
     device that has signed in once always opens - even offline or with Google down. Firebase's
     own session is checked in the background as today.
   - Existing 1.1 diaries on a phone keep all their data; they see the gate once, sign in, carry on.
   - No sign-out in 1.3 (one account per device, as in 1.2).
2. **Daily check-in screen.** After the gate, on boot and whenever the app becomes visible again,
   show a full-screen check-in if all hold: there is a current (reading) book, today is not already
   a reading date, and "Not yet" was not chosen today (`localStorage rd-notyet == localDate()`).
   - Shows the book cover/title, the current streak, and two big buttons.
   - **I read today** -> same code path as the Now card (duplicate guard, session
     `{read: true}`), toast, close.
   - **Not yet** -> store rd-notyet for today, close; no data written. The streak simply isn't
     extended today (it breaks at midnight if nothing is logged).
   - The Now card keeps its "I read today" button after "Not yet", so reading later the same day
     still counts.
   - Never shown over the sign-in gate, the handle sheet, or while the notebook is busy.
3. Versions: app 1.3.0, SW cache rd-v5.

## Out of scope
Sign-out, multiple accounts per device, push reminders.
