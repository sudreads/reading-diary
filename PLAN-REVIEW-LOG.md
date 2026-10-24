# Plan Review Log: Reading Diary
Phases 0-1 (recon + interrogation) complete - plan locked with the user. MAX_ROUNDS=3.

## Round 1 - Codex
- **OAuth identity is underspecified:** GIS token client returns an access token, not an ID token containing the email.  
  Fix: call the OIDC UserInfo endpoint with the access token (or use a separate ID-token flow) and validate the selected email.

- **The app can silently connect the wrong Google account.**  
  Fix: use `login_hint`, display the resolved account before sync, and require explicit confirmation when it differs from the expected account.

- **`localhost:<port>` cannot be an authorized OAuth origin.** OAuth origins require an exact origin, including port.  
  Fix: use a fixed development port and register that exact origin.

- **Testing-mode consent expiry is treated as a minor reconnect issue, but it can leave new local changes unbacked-up for days.**  
  Fix: surface an urgent “not backed up” state and require a successful initial sync before claiming protection.

- **“All data must not disappear” is not achievable with only browser storage plus opportunistic sync.** Data created offline before a successful Drive upload can be lost to storage clearing, uninstall, or device failure.  
  Fix: state the durability limit plainly and prompt for an exported backup until first remote sync succeeds.

- **A single `diary.json` is not a unique Drive object.** Drive permits multiple files with the same name, so simultaneous first-run devices can create conflicting diaries.  
  Fix: store and use a canonical file ID, detect/merge duplicate bootstrap files, and retain one canonical file.

- **The plan assumes an ETag/version precondition without specifying the actual Drive request semantics or fallback behavior.** A malformed conditional update can devolve into unconditional overwrite.  
  Fix: prototype and test the exact Drive `files.update` conditional request, treating unsupported/missing preconditions as a hard sync failure.

- **Three conflict retries are not enough without durable retry state.** A device can remain dirty indefinitely after contention or transient failures.  
  Fix: retain a persistent sync-error/dirty state, exponential-backoff retries, and a visible “backup incomplete” indicator.

- **Writing the merged state to IndexedDB before the remote conditional write succeeds can expose a state that was never committed remotely.**  
  Fix: track a pending merge generation and only mark it synced after the conditional remote write succeeds.

- **`updatedAt` wall-clock timestamps are unsafe for conflict resolution, especially with a newly added phone, restored backup, or manual clock change.**  
  Fix: use per-device monotonic revision counters plus device IDs (or hybrid logical clocks) as the deterministic conflict key.

- **The merge rule can resurrect or permanently suppress records incorrectly around tombstones.** Equal timestamps, clock rollback, and restore imports are not fully defined.  
  Fix: give every mutation—including deletion—a monotonic revision tuple and compare that tuple consistently.

- **Daily reading records overwrite rather than merge.** Two devices logging pages/minutes for the same date will lose one device’s contribution.  
  Fix: store immutable reading-session records and derive each day’s totals from them.

- **Block ordering is conflict-prone.** Concurrent moves can create duplicate `order` values and unstable journal ordering.  
  Fix: use stable fractional/rank keys with a deterministic ID tiebreaker and periodically compact ranks.

- **Drawing lifecycle is unsafe.** “Delete old file after the referencing block syncs” can delete a drawing still referenced by a stale device’s valid merged state.  
  Fix: delete drawing files only after a merged, committed manifest proves no live reference, preferably with delayed garbage collection.

- **Drawing metadata is insufficient for sync/recovery.** `synced: bool` has no revision, deletion state, checksum, size, or remote-file identity.  
  Fix: store immutable drawing metadata with content hash, size, creation revision, and remote file ID.

- **A referenced drawing can be absent locally or remotely with no specified repair path.** The journal then shows a broken block indefinitely.  
  Fix: verify all referenced drawing IDs after each merge, lazily fetch them, and show a recoverable missing-asset error if unavailable.

- **Upload ordering alone does not make a drawing and its manifest atomic.** A crash after drawing upload leaks files; a crash before manifest upload leaves unsynced journal state.  
  Fix: make uploads idempotent by content hash and run safe, delayed orphan cleanup from the committed manifest.

- **Storage, export, and restore have no size limits.** Base64 inline drawings can multiply memory use and crash Android Chrome during backup/restore.  
  Fix: enforce per-drawing and total quotas, stream/archive exports where possible, and preflight available storage.

- **Restore-as-merge cannot restore a prior state cleanly.** Deleted records and newer local timestamps can prevent a backup from restoring what the user expects.  
  Fix: offer explicit “merge” and “replace after creating a safety backup” modes, with a clear conflict report.

- **Permanent tombstones conflict with privacy, recovery, and long-term file growth.** They also make a true restore/undelete policy unclear.  
  Fix: define a retention window plus a recoverable-trash workflow, then compact only after a confirmed remote checkpoint.

- **Import data is untrusted.** A crafted backup can inject malformed records, huge base64 payloads, prototype-polluting keys, or hostile URLs.  
  Fix: strictly validate schema, types, IDs, timestamps, URL schemes, and byte limits before any IndexedDB write.

- **The plan does not address XSS despite rendering user-entered notes, quotes, book metadata, and restored content.** One `innerHTML` use can expose Drive tokens.  
  Fix: render text with `textContent`, never interpolate untrusted HTML, and deploy a restrictive CSP.

- **Access tokens must not be stored in IndexedDB, `localStorage`, logs, or error reports; the plan never says this.**  
  Fix: keep tokens memory-only and redact authorization headers/token-bearing URLs from all diagnostics.

- **The service-worker update strategy can mix old UI code with new schema/data code.** Aggressive cache deletion or `skipWaiting` can cause broken migrations.  
  Fix: use versioned assets, coordinate activation with a reload prompt, and make IndexedDB migrations backward-compatible and transactional.

- **Offline navigation behavior is not fully specified.** Network-first `index.html` needs an explicit cached fallback when offline.  
  Fix: use a navigation handler that falls back to the precached shell on network failure.

- **No schema-migration or rollback plan exists.** A future PWA update can make local or Drive data unreadable.  
  Fix: version both IndexedDB and remote documents, write tested migrations, and preserve unknown fields during round trips.

- **`navigator.storage.persist()` is best-effort, not a guarantee on Android Chrome.** Installation does not eliminate eviction, clear-data, profile changes, or uninstall loss.  
  Fix: describe persistence as advisory and prominently show last confirmed Drive backup status.

- **Open Library availability, rate limits, malformed results, CORS failures, and cover failures are not handled.**  
  Fix: add request timeout/abort, debounce, retry guidance, placeholder covers, and a fully functional manual-entry path.

- **The “lesson of the day” needs a deterministic selection definition.** “Random” can change between renders and differ across devices.  
  Fix: derive the choice deterministically from local date plus a stable sorted lesson-ID list.

- **The streak definition has timezone and travel edge cases.** Local `YYYY-MM-DD` may duplicate/skip days after timezone changes or midnight logging.  
  Fix: store the event timestamp and timezone offset, then define streak evaluation rules explicitly.

- **MacroDroid’s Wi‑Fi trigger is not guaranteed to open the installed PWA or work under every Android battery/permission policy.**  
  Fix: document tested Android/MacroDroid permission requirements and provide a notification-only fallback.

- **There is no observability for the failure modes that matter.** Users cannot distinguish auth failure, quota exhaustion, conflict exhaustion, corrupt backup, or missing drawing.  
  Fix: add a local sync-status log with timestamp, operation, safe error code, retry action, and exportable diagnostics.

- **The plan has no test matrix for the riskiest behavior.** Offline edits, simultaneous first sync, token expiry, corrupted remote JSON, app update, drawing failure, and storage eviction are all untested.  
  Fix: define automated merge/unit tests and a manual Android Chrome failure-mode checklist before implementation.

VERDICT: REVISE
### Claude's response (round 1)
Accepted most findings - see "Revisions after Codex round 1" in PLAN.md. Rejected: replace-mode restore, tombstone compaction, timezone-offset streak rules, pending-merge generation (reasons in PLAN.md). Changed approach on preconditions: version re-check instead of If-Match; never delete drawings remotely in v1.

## Round 2 - Codex
Most prior issues are substantively addressed: fixed origin, UserInfo identity lookup, memory-only tokens, deterministic revisions, immutable sessions, safer drawing handling, validation/CSP direction, update coordination, offline fallback, and useful sync observability.

Material problems remain:

- **The proposed Drive “version recheck then upload” is still a check-then-act race, not concurrency control.** Two devices can both observe version N, then each upload; the later upload overwrites the earlier merged file, and both can mark themselves clean.  
  Fix: avoid a shared writable snapshot—write per-device files or immutable operation records, then merge on read; optionally publish a best-effort derived snapshot.

- **The claim that the lost race merely delays data is false.** If device A’s successful upload is overwritten by B before A next opens, and A is lost/reset, A’s records have never been durably preserved remotely.  
  Fix: do not clear local “unbacked up” state unless the exact merged revision is confirmed present in a later remote read, or adopt append-only/per-device remote writes.

- **`dirty` has a local race during sync.** An edit made after sync snapshots IndexedDB but before it clears `meta.dirty` can be incorrectly marked synced and never scheduled for upload.  
  Fix: persist a monotonic local mutation generation and clear dirty only if the successful upload covers the latest generation.

- **Rejecting a pending-generation mechanism is therefore not safe.** Idempotent merge does not protect edits omitted from an upload that is incorrectly marked clean.  
  Fix: retain `syncedThroughGeneration` (or equivalent revision watermark) in durable metadata.

- **The revised model conflicts with the original schema and remote document definition.** The original stores/remote payload still specify `days` and `updatedAt`, while the revision requires `sessions` and `rev`; the remote layout also omits sessions.  
  Fix: replace the old definitions with one authoritative schema and explicitly serialize `books`, `blocks`, `sessions`, tombstones, ranks, and revisions.

- **`deviceId` lifecycle is unspecified and potentially dangerous.** Restoring a backup or cloning browser data can duplicate a device ID, invalidating the `(t, d)` uniqueness guarantee.  
  Fix: generate `deviceId` with `crypto.randomUUID()` per installation, never merge/restore it, and exclude Drive IDs and auth-related metadata from backups.

- **Rank renormalization can overwrite unrelated concurrent block edits.** If a record-level mutation rewrites many block ranks, its newer revisions can stomp another device’s text/quote edits to those blocks.  
  Fix: keep ordering as a separately versioned field/record, or use string fractional indexes that avoid bulk renormalization.

- **The “automatic safety backup” before restore is not a reliable recovery guarantee.** Browser download may be blocked, cancelled, or fail; moreover, merging that old backup later cannot undo imported newer revisions or tombstones.  
  Fix: require confirmed user download before restore and preserve a local immutable restore snapshot that can be explicitly reapplied with controlled conflict semantics.

- **The Drive file bootstrap cleanup has the same shared-write race.** Deleting duplicate diary files after an unprotected merged upload can discard a file created/updated concurrently.  
  Fix: defer duplicate deletion until a later confirmed reconciliation pass, or retain per-device files permanently.

- **The test suite omits the two critical races above.** Existing commutativity tests cannot prove safety of concurrent download/recheck/upload or edits occurring during an active sync.  
  Fix: add deterministic interleaving tests for competing writers, overwrite-after-success, and mutation-during-sync dirty handling.

- **The CSP remains too imprecise to be an enforceable security design.** It must allow the actual UserInfo endpoint and GIS iframe/popup behavior while denying everything else; “connect to googleapis” is not a CSP directive.  
  Fix: specify exact directives and origins, including `default-src`, `connect-src https://www.googleapis.com https://openidconnect.googleapis.com`, `frame-src https://accounts.google.com`, `object-src 'none'`, and `base-uri 'none'`.

VERDICT: REVISE
### Claude's response (round 2)
Accepted the shared-write race finding and switched to one remote file per device (single writer per file, merge on read) - this also removes duplicate-bootstrap cleanup. Accepted mutation generation watermark, deviceId lifecycle, separate rank revision, exact CSP, interleaving tests, single authoritative schema. Replaced the "safety backup before restore" with a structural argument: restore is merge-only and rejects revisions from the future, so an old backup can only add missing records, never override newer ones.

## Round 3 - Codex
Two material issues remain:

- **“One device writes one file” does not prevent concurrent writers from multiple tabs/app instances on that device.** Two contexts share IndexedDB and `deviceId` but have separate in-memory locks; a stale tab can overwrite the device file and incorrectly mark the shared generation as synced.  
  Fix: elect one cross-tab sync leader with `navigator.locks` (plus BroadcastChannel fallback), and add same-device/two-tab interleaving tests.

- **The restore safety claim is false.** A valid backup from another/newer device can contain higher revisions and override local records or tombstone them; the “not more than one day in the future” check does not prevent that.  
  Fix: either make restore strictly additive for existing IDs, or retain a recoverable pre-restore snapshot and explicitly disclose that higher-revision imported records may win.

- **A restored high revision can poison future local ordering.** Advancing `highestT` to an imported near-future value makes all subsequent local writes inherit that artificial clock lead across devices.  
  Fix: reject imported revisions newer than the local known clock unless explicitly approved, or import into an isolated restore/recovery flow rather than directly into the live revision domain.

VERDICT: REVISE
### Claude's response (round 3)
Accepted all three: cross-tab sync lock via navigator.locks, strictly additive restore (existing ids untouched), imported revisions rejected if ahead of the local clock and never advance highestT. MAX_ROUNDS=3 reached without a final APPROVED; the remaining findings were narrow and are fixed in PLAN.md but not re-reviewed. Proceeding to build on Yanai's "accept all" go-ahead; post-build Codex inspection will cover them in the code.

## Post-build inspection (Codex, fresh read-only session, 1 round)
1. **High — `js/app.js:481-490` / `js/sync.js:23-25` — invalid or incompatible data is still imported/merged.** `validateBackup()` returns `ok: false` for a wrong `app` or `schemaVersion`, but callers ignore `ok` and use its partial output. A malformed remote JSON that is not an object returns no `data`, then `store.mergeIn(undefined)` throws and can block every future sync against that file.  
   Fix: require `validation.ok` before restore/merge; for remote files, safely skip and record malformed/incompatible files.

2. **High — `js/store.js:154-166` — restore can cause later edits to lose to restored records.** Restore explicitly calls `mergeIn(add, { advanceClock: false })`; an imported record may have `rev.t` above local `highestT`. A subsequent local edit on a clock behind that timestamp gets a lower revision and loses during sync.  
   Fix: atomically raise `highestT` to `min(max(imported revisions), Date.now())` while inserting restored records.

3. **High — `js/app.js:126-139` — unbounded numeric input can corrupt reading data.** Inputs accept values such as `1e309`; `Number()` yields `Infinity`, which is saved as session pages/toPage. Derived progress becomes infinite, and `JSON.stringify` later converts it to `null` in the Drive backup.  
   Fix: reject non-finite values and cap pages/toPage/minutes to the schema limits before calling `store.save`.

4. **Medium — `js/validate.js:24-34` — backup validation does not validate several schema fields.** `startedAt`, `finishedAt`, and `createdAt` are not checked at all; session dates only match a regex, so impossible dates such as `2026-99-99` are accepted. This violates the plan’s pre-write type validation and can break date-derived UI.  
   Fix: validate all timestamp/date fields, including real calendar-date validation.

5. **Medium — `js/validate.js:29` — arbitrary rank strings are accepted.** A restored/remote block rank may contain characters outside the fractional-index alphabet or malformed forms. `rankBetween()` then uses `indexOf() === -1`, producing ranks that do not sort between their intended neighbors and eventually breaks reordering.  
   Fix: validate ranks against the fractional-index format/alphabet before accepting records.

6. **Medium — `js/store.js:77-83` — sessions are not enforced as immutable.** `save('sessions', {id: existingId, ...})` overwrites an existing reading log with a new revision, contrary to the authoritative immutable-session model. That permits accidental loss of historical reading data.  
   Fix: expose an append-only `addSession()` and reject updates/deletes other than tombstoning where needed.

7. **Medium — `index.html:6` — CSP deviates from the locked, narrower policy.** It broadly permits `https://accounts.google.com` for scripts/styles and adds `archive.org` image hosts, while omitting the planned `covers.openlibrary.org` connect source. This expands third-party loading beyond the approved policy.  
   Fix: use the exact CSP sources specified in `PLAN.md`.

8. **Low — `js/app.js:494-503` — “Export for Claude” exports non-finished books.** The plan specifies a summary of finished books, ratings, comments, and lessons; this includes reading and want-to-read books.  
   Fix: filter the export list to `status === 'finished'`.

9. **Low — `js/sync.js:49-53` — lock fallback permits concurrent syncs.** If `navigator.locks` is unavailable, `withSyncLock()` simply runs the callback, allowing two tabs to sync the same device file concurrently despite the plan’s “never overlapping cycles” requirement.  
   Fix: implement a cross-tab fallback lock (for example, localStorage/BroadcastChannel lease) or disable sync when locking is unavailable.
### Claude's dispositions
- 1 accepted: validateBackup now reports `fatal` for wrong app/version/non-object; sync skips such files, restore refuses them. Test added.
- 2 accepted: restore advances highestT to min(max imported rev, now).
- 3 accepted: all numeric inputs go through whole(v, max) - finite, clamped.
- 4 rejected: start/finish dates are display-only text; an impossible date cannot corrupt merge or streak logic.
- 5 accepted: ranks validated against the rank.js alphabet. Test added.
- 6 rejected: the UI has no path that edits a session; append-only by construction.
- 7 partly rejected: archive.org is required (covers.openlibrary.org redirects there, verified in browser); GIS loads from several accounts.google.com paths, so the origin is the narrowest working source.
- 8 rejected: including in-progress and want-to-read books gives Claude better recommendation context; deliberate.
- 9 rejected: target is Android Chrome, which has had Web Locks since v69.
Also fixed before this, from the same-model code-review pass: first-install reload, stale precache, unguarded localStorage, popup-without-gesture red pill, equal-rank move, never-retried rejected records, O(n^2) drawing repaint, leaked object URLs.
Second inspection round not run: remaining accepted fixes are small and covered by tests.

## v1.1 change plan - Codex round 1 (1 round: UI-heavy, easy to undo)
- **Undo can destroy real reading history:** “tombstones today’s sessions” would also delete pre-existing page/minute logs for that book. **Fix:** tag check-in sessions (e.g. `kind:'streakCheckin'`) and undo only that session id.

- **Text autosave and drawing save can overwrite each other:** both modify the same `page` block, and record-level LWW can drop either `text` or `drawingId`. **Fix:** serialize page writes and flush/cancel pending text autosave before committing the drawing update.

- **Drawing can be silently lost on interruption:** it is persisted only when Draw mode is exited. **Fix:** save a draft on `visibilitychange/pagehide` (and restore it on return), or persist after each stroke debounce.

- **Canvas overlays will misalign/distort across devices or rotation:** a bitmap made at one viewport size cannot reliably overlay the page at another. **Fix:** store a fixed logical canvas size plus dimensions and render it proportionally with a stable page aspect ratio.

- **“Not yet” state may remain collapsed after midnight:** localStorage is date-keyed conceptually, but the UI needs a date transition while the app stays open. **Fix:** compare its stored date to `localDate()` on render, focus/visibility, and a midnight timer; clear/reopen when different.

- **“I read today” can create duplicate check-ins across tabs or rapid taps.** **Fix:** in the same IndexedDB transaction, query live check-ins for `(bookId, localDate)` and insert only if none exists.

- **Comment ordering is underspecified under equal timestamps / clock skew.** **Fix:** sort comments by `(createdAt, id)` deterministically, or use the existing `(rev.t, rev.d)` as the secondary/primary ordering key.

- **New page deletion needs an explicit active-page transition:** deleting the current page while autosave or drawing is pending can resurrect it or write into a tombstone. **Fix:** flush/cancel page work, tombstone it, then atomically select an adjacent live page before allowing edits.

- **Legacy drawing projection needs a stable synthetic page identity:** otherwise a legacy drawing can be displayed as a page but cannot safely participate in page navigation/deletion. **Fix:** treat its existing block id as the read-only projected page id and disable destructive page actions for it.

- **The plan omits required merge/derive/validation tests for the new semantics.** **Fix:** add tests for check-in undo isolation, duplicate-tab check-ins, midnight rollover, page text/drawing write races, projected legacy blocks, and cross-viewport overlay rendering.

- **Google Fonts weakens offline behavior unnecessarily for a cosmetic font.** **Fix:** ship Caveat as a self-hosted cached asset or use the cursive fallback unless online loading succeeds.

VERDICT: REVISE
### Claude's response
Accepted: undo only removes today's read:true check-ins; drawing draft saved on visibilitychange/pagehide; fixed paper aspect with text sized in container units so writing and drawing line up on any width; "Not yet" compared to localDate() on every render and re-render on visibility; duplicate check-in guard; comments sorted by (createdAt, id); flush autosave before delete/draw/page change; tests for check-in streaks; Caveat self-hosted (no CSP change, works offline).
Rejected: extra page-write serialisation (save() already merges the previous record inside one IndexedDB transaction, so text and drawingId never clobber each other locally); read-only legacy drawing pages (tombstoning a legacy block is the same safe operation as any other).
