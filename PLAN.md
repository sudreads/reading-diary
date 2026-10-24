# Plan: Reading Diary
_Locked via claudex-loop - by Claude + Yanai, 2026-10-24. Revised after Codex rounds 1-2._

## Goal
A free, personal reading companion that Yanai (17, Android, Chrome) installs to his home
screen. It solves four problems: forgetting lessons (a per-book journal with mixed
text / drawing / quote / lesson blocks, plus a deterministic "lesson of the day"), forgetting
to read (streak + daily goal in-app; the nudge itself comes from a MacroDroid automation on
home-Wi-Fi join), a trophy road of finished books with rating + comment, and future book
suggestions (an "Export for Claude" button, nothing in-app). Data is his alone and must not
silently disappear: local first, auto-saved to the hidden appDataFolder of his Google Drive
(his "SUN" account), with an always-visible backup status.

## App shell
- Static PWA, vanilla JS ES modules, no build step: `index.html`, `app.css`, `js/*.js`,
  `manifest.webmanifest`, `sw.js`, `icons/`. Hosted later on GitHub Pages of a new GitHub
  account (public code, private data). Dev: `http://localhost:8790` exactly (static Python
  server via `.claude/launch.json`), registered as an authorized JS origin.
- Service worker: precache the versioned shell; navigations network-first with cached
  `index.html` fallback offline; assets cache-first. A new SW waits; the app shows "Update ready
  - reload" and only then posts `skipWaiting`. Google and Open Library responses never cached
  by the SW.
- CSP meta tag: `default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client;
  style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style;
  img-src 'self' blob: data: https://covers.openlibrary.org https://*.googleusercontent.com;
  connect-src 'self' https://www.googleapis.com https://openidconnect.googleapis.com
  https://openlibrary.org https://covers.openlibrary.org; frame-src https://accounts.google.com;
  object-src 'none'; base-uri 'none'; form-action 'none'`.
- All user / Open Library / backup text rendered with `textContent` / attribute setters only;
  no `innerHTML` with data anywhere.

## Data model (the one authoritative schema)
Every syncable record carries `id` (crypto.randomUUID), `rev: {t, d}`, `deleted: bool`
(tombstones kept forever - they are tiny), and preserves unknown fields on round-trip.
- `rev.t = max(Date.now(), meta.highestT + 1)`; `meta.highestT` is bumped to the max `t` seen
  on every local write and every merge. `rev.d = deviceId`. Compare `(t, d)` lexicographically:
  deterministic, no ties, tolerant of a wrong phone clock.
- `books` {title, author, coverUrl, olKey, status: reading|finished|want, startedAt,
  finishedAt, rating 0-5, comment, totalPages}
- `blocks` {bookId, type: text|quote|lesson|drawing, text, drawingId, createdAt}, plus
  **`rank` (string fractional index) and `rankRev` as an independently merged field**, so
  reordering never overwrites a content edit and vice versa. String fractional indexes never
  need bulk renormalisation.
- `sessions` {bookId, date (local YYYY-MM-DD at log time), pages, minutes, toPage} -
  immutable reading log; day totals, current page and streak are derived, so two devices can
  never overwrite each other's reading.
- `drawings` (local only) {id, blob image/webp max 1080 px q0.8, refused above 1.5 MB,
  bytes, uploaded: bool}. Drawing ids are uuids; a redraw makes a new drawing.
- `meta` (local only, never synced, never in backups): deviceId (randomUUID per install,
  generated on first open), highestT, `mutationGen` (incremented in the same IndexedDB
  transaction as every syncable write), `syncedThroughGen`, lastSyncOk, Drive file ids,
  sync log (last 50: time, op, ok, safe error code - no tokens, no note text), settings.

Merge(a, b): union by id; for each id pick the record with higher `rev`, then independently
pick `rank`/`rankRev` from whichever side has the higher `rankRev`. Commutative, associative,
idempotent.

## Google Drive sync - one file per device
- Auth: Google Identity Services token client, scopes `drive.appdata openid email`,
  `login_hint` only if EXPECTED_EMAIL is set (blank in public code). After a token, call
  `https://openidconnect.googleapis.com/v1/userinfo` for the email; if it is not the expected
  one, show it and require "Yes, use this account" before any sync. Tokens live in memory only.
  Silent re-auth (`prompt: ''`) on open / user gesture; on failure a red "Drive disconnected -
  tap to reconnect" pill. Local use is never blocked.
- Remote layout in appDataFolder:
  - `device-<deviceId>.json` - this device's full known state (books, blocks, sessions incl.
    tombstones, schemaVersion, deviceId, savedAt). **Only this device ever writes it**, so there
    is no shared-write race and no precondition dance.
  - `drawing-<id>.webp` - immutable; upload is idempotent (list by name, create if absent).
    No remote deletion of drawings in v1.
- Sync cycle (one at a time per device: `navigator.locks.request('rd-sync', {ifAvailable: true})`,
  so a second tab of the app never runs a concurrent cycle against the same device file):
  1. `gen = meta.mutationGen`; snapshot local records.
  2. `files.list` all `device-*.json`; download those whose `modifiedTime` changed since last
     seen; merge all of them into the snapshot; write merged records to IndexedDB in one
     transaction (re-reading and re-merging any record written locally meanwhile).
  3. Upload any `uploaded:false` drawing referenced by a live block.
  4. Upload this device's merged state to `device-<deviceId>.json` (create on first sync, store
     its file id).
  5. Re-read that file's metadata to confirm it exists with the new `modifiedTime`; only then
     set `syncedThroughGen = gen` and `lastSyncOk = now`. Edits made during the cycle have
     `mutationGen > gen`, stay "not backed up", and trigger another cycle.
- Triggers: app open, 5 s debounce after a write, `visibilitychange` -> hidden (best effort),
  manual "Sync now". Failures back off exponentially 30 s -> 30 min; state persists in meta.
- Status pill, always visible: green "Saved to Drive 2 min ago" (`syncedThroughGen ==
  mutationGen`), amber "Not backed up yet - N changes" (offers "Download backup" until the
  first sync ever succeeds), red "Drive disconnected".
- New phone: connect Drive -> merge all device files -> everything comes back; the new device
  gets its own deviceId and file.
- Missing drawing locally: lazy download when shown; if absent remotely, placeholder
  "Drawing not available - retry" instead of a broken block.

## Backup / restore / export (Settings)
- "Download backup": one JSON (records + drawings as base64), excluding meta / deviceId /
  Drive ids / tokens.
- "Restore from backup": **strictly additive** - only records whose id does not exist locally
  (live or tombstoned) are inserted; existing ids are never touched, so a restore can never
  override or delete current data. Validation before any write: schema version, types,
  string length caps, uuid ids, `rev.t` not after `max(now, highestT)` (rejected, not clamped),
  cover URLs https on openlibrary hosts only, drawing size caps. Imported records do not
  advance `highestT` beyond the current wall clock.
- "Export for Claude": plain-text summary of finished books, ratings, comments, lessons, via
  Web Share or clipboard.
- Persistence: call `navigator.storage.persist()`; Settings says "requested from Chrome (best
  effort)"; the real guarantee shown is the last confirmed Drive save.

## Screens (bottom tab bar)
- **Now:** current book, derived page progress, "I read today" (pages / minutes / to page),
  streak flame (consecutive local dates with a live session; today unlogged does not break it
  until midnight), daily goal, lesson of the day = sorted live lesson ids,
  `hash(localDate) % count`.
- **Journal:** book picker -> blocks in rank order; add note / quote / lesson / drawing;
  edit, delete, move up/down. Drawing editor: full-screen canvas, pointer events, 4 colours,
  2 widths, eraser, undo, clear, save.
- **Trophy road:** vertical winding path of finished books (cover, title, stars), newest at
  top, ghost "next up" node for the current book. Tap -> sheet with rating, comment, top
  lesson, dates. Finishing a book prompts rating + comment.
- **Settings:** account + status + sync log, backup / restore / export, reminders guide
  (MacroDroid: trigger Wi-Fi SSID connected; action notification "Time to read"; tap opens the
  app URL; notification-only fallback and a fixed-time fallback, with the battery-optimisation
  exemption step).
- Add book: Open Library search (300 ms debounce, 8 s abort timeout, placeholder cover on
  error) or manual entry, always available.
- First run: offer to add "Make Your Bed" (finished) and "Rich Dad Poor Dad" (reading).

## Tests
- `tests/*.test.mjs` with `node --test` on pure modules (`merge.js`, `rev.js`, `rank.js`,
  `derive.js`, `validate.js`, `sync.js` against an in-memory fake Drive):
  merge commutativity / associativity / idempotence; tombstone vs older edit and newer edit vs
  tombstone; clock-skewed device; rank and content edits merging independently; two devices
  syncing in every interleaving of their steps against the fake Drive with no record lost;
  an edit during an active cycle stays not-backed-up and is uploaded next cycle; streak and
  totals derivation; restore validation rejecting future revs, bad URLs, oversize payloads; restore never
  changes an existing id; two tabs on one device never run overlapping cycles.
- Browser check on localhost: add book, journal blocks, drawing, finish -> trophy road,
  offline reload, backup -> restore round-trip, no console errors.

## Key decisions & tradeoffs
- Local-first + per-device files in appDataFolder over a hosted DB: zero cost, his own Google
  account, no backend, no write races. Cost: hourly-ish silent re-auth, occasional
  "Reconnect" tap.
- No push server: MacroDroid does the home-Wi-Fi nudge.
- No remote drawing deletion in v1 (removes GC hazards; a few MB of orphans is fine).
- Rejected: replace-mode restore, tombstone compaction, timezone-offset streak rules.
- Locked via escape hatch: new GitHub account hosting, MacroDroid, Open Library, no in-app
  recommendations.

## Risks / open questions
- Testing-mode OAuth may need re-consent periodically; the red pill handles it.
- Pushing to GitHub needs Yanai's explicit go-ahead; until then localhost only.

## Out of scope
- Other users, sharing, in-app recommendations, push server, native app, iOS-specific work.
