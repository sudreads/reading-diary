# Plan: Reading Diary 1.4 - Sign out (switch accounts on one phone)
_2026-10-24, Yanai chose "Add Sign out". Builds on PLAN.md (per-device Drive files, mutationGen /
syncedThroughGen), PLAN-v1.2.md (Firebase, ownerUid, review outbox) and PLAN-v1.3.md (gate)._

## Goal
Settings -> **Sign out** lets a different person (or Yanai's second account) use the same phone.
Signing out must never lose diary data: everything must already be in the owner's Drive. Signing
back in with the owner account restores the whole diary from Drive.

## Flow
1. Settings -> Reader account -> "Sign out" (only when ownerUid is set).
2. Pre-flight, with a progress sheet. Every step must pass or sign-out stops with the reason:
   a. Online.
   b. Flush the notebook (pending text, open drawing).
   c. Connect Drive interactively **as the owner** (account picker; the userinfo email must equal
      confirmedEmail and the Firebase uid must equal ownerUid - the existing identity checks).
   d. Run a full sync cycle and then require `syncedThroughGen === mutationGen` (re-read after
      the cycle, under the sync lock) and **no drawings with uploaded:false** that a live block
      references.
   e. Drain the review outbox and require it empty.
   f. Re-check (d) once more immediately before wiping, inside the same lock, so an edit made
      during pre-flight is not lost.
3. If pre-flight fails: show why, and offer **Download backup** (existing file export) plus
   **Sign out anyway**, which is only enabled after the backup file was downloaded in this
   sheet and needs a confirm.
4. Wipe: Firebase signOut, drive.forget(), close the IndexedDB connection and
   `indexedDB.deleteDatabase('reading-diary')` (onblocked -> "close other Reading Diary tabs"),
   remove `rd-*` localStorage keys, then reload. The app starts empty, so the 1.3 sign-in gate
   shows.
5. Next sign-in (any account): new deviceId; the existing first sync merges every
   `device-*.json` in **that** account's appDataFolder, so the owner gets the full diary back;
   drawings download lazily as already designed. The old device file stays in Drive (harmless:
   merge is idempotent).
6. Copy: the button says "Sign out", the sheet explains "Everything is saved to your Google Drive
   first. Sign back in any time to get it all back."

## Revisions after Codex round 1 (override the flow above where they differ)
- **Show who I am** (Yanai's request): Settings -> Reader account shows `@handle` and the Google
  email the diary belongs to (from the Firebase user, persisted locally; display only, never
  written to Firestore).
- **No bypass.** "Sign out anyway" is removed. If the diary can't be proven safe in Drive, sign-out
  is refused; the sheet offers Download backup and says what to fix (go online, reconnect Drive).
- **Single active writer.** Sign-out broadcasts `signing-out` on a BroadcastChannel; other tabs
  close their DB connection and show "Signed out in another tab - reload". The progress sheet is
  modal (no editing possible). The final readiness check and the wipe run back-to-back with no
  user interaction in between. `deleteDatabase` onblocked or onerror = hard failure: nothing is
  reloaded, the sheet says to close other tabs and try again.
- **Prove the backup, don't assume it.** After the final sync: download this device's own
  `device-<id>.json` back from Drive and check every local record (books, blocks, sessions incl.
  tombstones) is present with an equal-or-newer revision; list `drawing-*.webp` names in Drive
  and check every drawing referenced by a live block is there. Any miss = refuse.
- **Identity by Google `sub`, not email.** On first sign-in store `ownerGoogleSub` (userinfo `sub`)
  next to ownerUid; every Drive operation requires userinfo `sub == ownerGoogleSub` and the
  Firebase user's Google provider uid to equal it too. (Existing diaries backfill it on the next
  successful identity check.)
- **Verified cleanup.** Await Firebase `signOut()`; delete the `reading-diary` database and
  Firebase's own `firebaseLocalStorageDb`; remove all `rd-*` localStorage keys; drop the in-memory
  Drive token. Each step awaited; on any failure stop without reload and say so. Then reload ->
  empty app -> sign-in gate.
- **Tests:** node tests for `signOutReady(...)` and `backupCovers(local, remote)` (missing record,
  older remote rev, missing drawing all refuse). Browser: blocked-delete path (second tab open)
  refuses; modal blocks edits; after a successful sign-out the local DB is gone and the gate shows.
  The real Drive round trip (sign out, sign back in, data returns) is tested on Yanai's phone.
- **Rejected:** a cross-tab acknowledgement protocol beyond the broadcast + hard-fail on a blocked
  delete (the blocked delete already proves another tab still holds the DB, so it is the real
  guarantee); verifying drawing *contents* by hash (immutable uploads + name check is enough).

## Out of scope
Several accounts kept side by side on one phone (fast switching without re-download).

## Tests
- Node: a pure `signOutReady({mutationGen, syncedThroughGen, unsentDrawings, outbox, online})`
  returning ok or the first blocking reason.
- Browser: diary with a book, note, drawing and check-in -> sign out (with a fake/real Drive
  where possible) -> gate shows and local DB is empty -> sign back in -> data back.
