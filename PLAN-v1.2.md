# Plan: Reading Diary 1.2 - accounts + public reviews
_Locked via claudex-loop - Claude + Yanai ("accept all"), 2026-10-24. Consolidated after Codex
rounds 1-2; this is the single authoritative version. PLAN.md / PLAN-v1.1.md local-first rules
still hold for the private diary._

## Goal
Several people use the app, each with their own Google account and their own private diary
(notebook, comments, streak stay on their phone + their own Drive appDataFolder, unchanged).
New: when someone finishes a book, their star rating + review are published to a shared
Firestore database, and every signed-in beta member can read the reviews for any book, like
Google reviews. Yanai is admin and can delete any review. Launch is an **invite-only beta**.

## 1. Project and launch
- One Firebase project (Spark, free) which is also the Google Cloud project holding the Drive API,
  the OAuth consent screen and the OAuth web client. Yanai is the sole owner.
- Firestore Native mode. Firebase Auth with the Google provider enabled. Authorized domains
  `sudreads.github.io`, `localhost`. Browser API key restricted by HTTP referrer to those origins
  (not a secret; rules are the real protection).
- OAuth consent screen stays in **Testing**; Yanai adds friends as test users (cap 100). Testing
  mode can make users re-consent periodically for the Drive token; onboarding says so and the
  amber "tap to save" pill already handles it. Firebase stays signed in independently.
- Production (Search Console verification of `sudreads.github.io`, brand verification, App Check)
  is a later, separate step.

## 2. Sign-in and identity
- The existing GIS token client requests `drive.appdata openid email`. The access token is passed
  to Firebase via `signInWithCredential(GoogleAuthProvider.credential(null, accessToken))` (REST;
  no Firebase popup or cross-site iframe, which break on github.io and in installed PWAs).
- Firebase SDK 12.19.0 (modular ESM from `https://www.gstatic.com/firebasejs/12.19.0/`; latest 12.x older than two weeks, matching the emulator test dependency) is imported
  lazily, only for sign-in and reviews; the offline shell and diary never depend on it. Firestore
  uses the **memory cache only**, so no queued write replays after sign-out or account switch.
- Account binding: `meta.ownerUid` set on the device's first Firebase sign-in. After **every** GIS
  response, the userinfo email must equal the bound account and the Firebase uid must equal
  `meta.ownerUid` before any Drive or Firestore call; otherwise stop and show "This diary belongs
  to @handle - sign in with that account". One account per device.
- CSP adds script-src `https://www.gstatic.com`; connect-src `https://firestore.googleapis.com
  https://identitytoolkit.googleapis.com https://securetoken.googleapis.com`.

## 3. Firestore data model (no email, no Drive data, no book metadata)
- `users/{uid}`: `{handle, createdAt}`
- `handles/{handle}`: `{uid, createdAt}` - handle `^[a-z0-9_]{3,20}$`, shown as @handle,
  **immutable and never released** (no rename in 1.2).
- `works/{workId}/reviews/{uid}`: `{workId, uid, handle, rating, text, createdAt, updatedAt}` -
  workId `^OL\d+W$` from the book's Open Library `olKey`. One review per person per book by path.
  Title/author/cover are never stored; the UI shows them from the local book / Open Library.
- `reports/{workId}_{reviewerUid}_{reporterUid}`: `{workId, reviewerUid, uid, reason, createdAt}`,
  reason in `['spam','mean','spoiler','other']`.
- `admins/{uid}`: `{}` - created by hand in the console for Yanai.
- Exact post times are visible to all beta members (Firestore returns the whole document); the UI
  shows month + year, and the privacy page discloses the exact-time visibility.

## 4. Security rules (`firestore.rules`) - the contract
Helpers: `signedIn()`, `me()`, `isAdmin() = exists(/databases/$(database)/documents/admins/$(me()))`,
`exact(R) = keys().hasAll(R) && keys().hasOnly(R)`.
- Default deny everything; every allow requires `signedIn()`.
- `users/{uid}`: get if `uid == me()`; create if `uid == me()`, exact `[handle, createdAt]`,
  `createdAt == request.time`, `getAfter(handles/$(handle)).data.uid == me()`; no update; **no
  delete** - the user doc is the permanent per-account sentinel, so a uid can claim exactly one
  handle ever (no rename or hoarding by delete-and-reclaim).
- `handles/{h}`: get if signedIn (availability check); list denied; create if `h` matches the
  regex, `!exists(handles/h)`, exact `[uid, createdAt]`, `uid == me()`, `createdAt == request.time`,
  `!exists(users/me())` before and `getAfter(users/me()).data.handle == h`; no update, no delete.
- `works/{workId}/reviews/{uid}`: get/list if signedIn and `request.query.limit <= 50` for list;
  create if `uid == me()`, `workId` matches the regex and equals `request.resource.data.workId`,
  exact `[workId, uid, handle, rating, text, createdAt, updatedAt]`, `rating is int` 1-5,
  `text is string && text.size() <= 2000`, `handle == get(users/me()).data.handle`,
  `createdAt == request.time`, `updatedAt == request.time`; update if owner and
  `diff(resource.data).affectedKeys().hasOnly(['rating','text','updatedAt'])`, same validations,
  `updatedAt == request.time`; delete if owner or `isAdmin()`.
- **No collection-group queries** over reviews (an overlapping rule would let anyone list reviews
  across all works). Delete-my-data uses the known paths `works/{workId}/reviews/{me}` from the
  merged diary.
- `reports/{id}`: create if id == `workId + '_' + reviewerUid + '_' + me()`, exact keys,
  `uid == me()`, reason in the enum, target review `exists()`, `createdAt == request.time`;
  get/list/delete if `isAdmin()` or `resource.data.uid == me()`; no update.
- `admins/{uid}`: get if `uid == me()`; no client writes.

## 5. Reviews UI
- "Reviews" sheet from Trophies (book sheet) and from Add-book search results: average stars and
  count ("from the latest N" once there are 50+), list newest first (name, stars, month+year,
  text, Report; Delete on own, and on all for admins). Query
  `works/{workId}/reviews orderBy createdAt desc limit 50`, "Load more" via `startAfter`.
  Edits never reorder.
- Finish sheet: switch "Post publicly", default on, with "Everyone in the beta will see this as
  @handle". Stored on the book as `publicReview: bool` (synced via Drive like the diary). Hand-
  typed books (no workId): "Private only - pick the book from search to share reviews".
- First sign-in with no `users/{uid}`: pick a handle (live `get` availability check), claim with
  one batch (`handles/{h}` + `users/{uid}`).

## 6. Review outbox
- `meta.reviewOutbox` = map `bookId -> gen`. Any local change to a book's rating, review text,
  status, publicReview or deletion bumps a per-book generation and stores it there.
- Drain (online + signed in + identity check passed), serially under the existing
  `navigator.locks` sync lock: for each entry, read the **current** merged book record, compute
  the desired remote state (finished && !deleted && publicReview && workId -> upsert current
  rating/text; else delete own review if present), write it, then remove the entry **only if its
  gen is unchanged**; otherwise leave it for the next pass. Backoff as in sync; results go to the
  Settings sync log.

## 7. Admin
- If `admins/{myUid}` exists: Delete on every review, and a Settings panel listing reports with
  "Delete review" / "Dismiss" plus a link to the Firebase usage page (quota watch).

## 8. Delete my public data (Settings)
- Resumable job in meta: delete own reviews at the known paths `works/{workId}/reviews/{me}` for
  every book in the merged diary that has a workId, own reports (`uid == me`), then
  `user.delete()` right after a fresh credential sign-in. `users/{uid}` and the handle stay as a
  permanent reservation `{handle, createdAt}` (said in the UI and privacy page).
  Private diary untouched.

## 9. privacy.html
What is stored where, what is public (handle, ratings, reviews, exact post time), community rules,
how to report, how to delete, contact. Linked from Settings and the first-sign-in screen.

## 10. Tests
- Node unit tests: handle validation, workId extraction, outbox generation logic (concurrent
  change during an in-flight write keeps the entry), desired-state computation.
- Rules: `@firebase/rules-unit-testing` against the Firestore emulator (needs JDK 21 - installing
  it is Yanai's call) covering every allow and deny path in section 4, the claim batch, the
  report target existence and admin paths, plus an explicit **denied** test for a signed-in
  member running `collectionGroup('reviews')` with limit 50, and for deleting `users/{uid}`. Rules are deployed only after
  these pass. No live negative testing against production.
- Browser end-to-end on localhost with Yanai's account and one test friend account.
- SW cache bumped; Firebase SDK not precached.

## Key decisions & tradeoffs
- GIS token -> Firebase credential instead of Firebase popup auth (reliability on github.io/PWA).
- Reviews under `works/{workId}` so rules authorise by path instead of trusting query filters.
- Immutable handles: no impersonation, no rename races; cost: no renaming in 1.2.
- Client-side average over <= 50 recent reviews; no Cloud Functions on Spark.
- Recompute-at-drain outbox with per-book generations: no resurrected or dropped reviews.
- Invite-only beta instead of public launch: moderation, verification and App Check deferred.
- Rejected: separate GCP projects, App Check in the beta, default-private reviews (Yanai's call),
  removing `uid` from review docs (needed for delete-my-data; already in the path).

## Assumptions
- `drive.appdata` is non-sensitive - developers.google.com/workspace/drive/api/guides/api-specific-auth.
- Spark: 50k reads / 20k writes per day free; overage shuts the product off for the month -
  firebase.google.com/docs/projects/billing/firebase-pricing-plans.
- Firebase popup/redirect auth off Firebase Hosting hits third-party storage problems -
  firebase.google.com/docs/auth/web/redirect-best-practices.

## Out of scope
Friends lists, likes, profile photos, notifications, renaming handles, multiple diaries per
device, signed-out review pages, production OAuth launch.
