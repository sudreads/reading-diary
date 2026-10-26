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

# v1.2 accounts + public reviews - plan review (MAX_ROUNDS=3)

## Round 1 - Codex
- **Username rules cannot prove the stated normalization:** Firestore Rules cannot reliably lowercase/collapse spaces; client-supplied `displayName`/`nameKey` enables lookalikes and broken uniqueness. **Fix:** use an immutable, rules-verifiable ASCII lowercase handle (`[a-z0-9_-]{3,24}`) as the only public identity.

- **A user can release an active name:** allowing deletion of their username lets another account claim it while old reviews still display that name. **Fix:** never delete claimed handles; reserve them permanently or retain historical aliases.

- **Rename is not atomic at scale:** user-doc update, old-name release, and rewriting reviews cannot fit one atomic operation beyond 500 writes, causing mixed identities and impersonation windows. **Fix:** make public handles immutable in v1; defer rename until a trusted backend migration exists.

- **“`keys().hasOnly`” is insufficient schema validation:** it allows omitted required fields unless paired with `hasAll`, and updates need `diff().affectedKeys()` constraints. **Fix:** enforce exact required keys/types on create and an explicit allowed-field diff on update.

- **Review authorization needs immutable-field checks:** the outline does not explicitly require existing `workId`, `uid`, and `createdAt` to remain unchanged on update. **Fix:** require equality to `resource.data` for all immutable fields and derive/validate document ID from them.

- **Username claiming needs a fully specified atomic rule:** `getAfter()` only helps if the batch must create exactly the claimed username and user record with matching values. **Fix:** require user creation/update and username creation in the same batch, with exact cross-document values and no pre-existing username.

- **Reports can be used for unlimited junk writes:** arbitrary `reviewId` values create unlimited unique report documents. **Fix:** require that the target review exists, restrict `reason` to a short enum, and allow one report per real review per reporter.

- **Client-side moderation is not an abuse-control system:** Google-account throwaways can spam reviews, names, and reports; auth-gating does not rate-limit. **Fix:** add App Check plus conservative client UX limits now, or postpone public posting until a backend can rate-limit and moderate.

- **All signed-in users can scrape the entire community:** `read any` on `users` and `reviews` exposes stable UIDs, handles, book history, review timestamps, and text to any Google account. **Fix:** remove public `users` reads, avoid exposing `uid` in review documents, and state clearly that reviews are public-to-all-members and enumerable.

- **The public review itself may reveal sensitive reading habits:** a teen’s name linked to books and timestamps is personal data, even without email. **Fix:** use pseudonymous handles by default, omit precise timestamps, add clear audience warnings and a “post anonymously/private” default.

- **Email/privacy leakage is under-specified:** Firebase Auth retains account metadata; persistent browser storage and Firestore caches can survive sign-out on a shared device. **Fix:** document this, offer explicit sign-out plus cache-clearing guidance, and do not enable persistent Firestore caching for public reviews unless needed.

- **The `publicReview` flag syncs through Drive and can leak unintentionally across devices:** a device that has not seen the latest opt-out can republish a review. **Fix:** make publication a separate explicit remote state with a monotonic operation revision and reconcile it serially.

- **The outbox has a resurrection race:** an older in-flight upsert may complete after a newer delete/opt-out and recreate the review. **Fix:** serialize operations per review and always run a final state reconciliation after each completion/restart.

- **The outbox “set of bookIds” loses intent/history:** deletion of a book, toggling public state repeatedly, and Drive merge conflicts are not represented durably enough. **Fix:** store per-review desired state plus a monotonically increasing local operation generation, retaining delete tombstones until acknowledged.

- **Deleting account data is not reliably complete from a browser:** reviews/reports may exceed batch limits, fail mid-pagination, and Firebase Auth identity deletion is omitted. **Fix:** provide resumable paginated deletion with progress, retain a local deletion job until confirmed, and explicitly reauthenticate then call Firebase Auth `deleteUser` if that is promised.

- **A deleted/recreated user can leave orphaned content:** if data deletion partially fails, the same Google identity can create a new profile while old reviews remain. **Fix:** block profile recreation until deletion completes, or keep a server-side account state—otherwise do not advertise deletion as complete.

- **Review averages/counts are wrong once a work has over 100 reviews:** a limited page cannot truthfully produce the global average or count. **Fix:** label it “latest 100 reviews” or drop aggregate claims until a trusted aggregation service exists.

- **“Newest first” is not implemented by the stated query:** no `orderBy` is specified, and ordering by `updatedAt` changes historical ordering after edits. **Fix:** explicitly order by a chosen immutable publication timestamp and explain that edits do not reorder reviews.

- **Review metadata is user-forgeable:** any user can attach arbitrary title/author/cover data to a valid Open Library work ID. **Fix:** treat those fields as untrusted display hints or fetch canonical metadata client-side from Open Library.

- **Admin identity is only safe if enforced in rules, not UI:** hiding/showing Delete based on an `admins` read is cosmetic. **Fix:** make every privileged rule check `exists(/databases/$(database)/documents/admins/$(request.auth.uid))` directly.

- **The Firebase project is an attractive combined blast radius:** one project holds Drive OAuth configuration, Auth, and the public database. **Fix:** use separate production Firebase/Google Cloud projects or at least separate OAuth clients and tightly scoped ownership/access.

- **API-key referrer restrictions do not protect Firestore from authenticated abuse:** the public key is not a secret, and abuse travels through valid clients. **Fix:** rely on strict rules/App Check/quota monitoring, not key secrecy, and alert before daily quota exhaustion.

- **Spark quota failure is a service-wide outage, not just an expensive request:** one scrape can consume daily reads; rename rewrites and delete jobs can also consume write/delete quota. **Fix:** impose small page sizes, explicit pagination, usage monitoring, and a hard product decision for what happens when quota is exhausted.

- **Firestore’s offline behavior is not specified:** cached writes can be replayed later after the user believes posting was disabled or after account changes. **Fix:** use memory cache for reviews or clearly expose pending remote writes and cancel/reconcile them on sign-out and account mismatch.

- **The auth-account binding is incomplete:** Firebase’s persisted user, the GIS token account, and the Drive-confirmed account can diverge across sessions. **Fix:** after every GIS response, compare the Firebase UID/account identity and Drive userinfo email against the bound owner before any Drive or Firestore operation.

- **`profile` is unnecessary for the described product:** custom public handles do not need Google profile access. **Fix:** request only `openid email drive.appdata` and avoid importing/displaying Google profile data.

- **Production OAuth readiness is optimistic:** GitHub Pages may not satisfy branding/domain-verification and privacy-policy ownership requirements for a public production OAuth app. **Fix:** validate production consent-screen/domain ownership with Google before implementation; plan a verified custom domain if required.

- **The privacy policy is not enough for a teen-facing public community:** it needs age/parental-consent handling where applicable, community rules, reporting response expectations, and a contact/deletion path. **Fix:** restrict launch to an appropriate age/jurisdiction or add these safeguards before inviting general users.

- **No backend means no durable moderation, audit trail, or emergency response:** Yanai’s manual console account cannot realistically handle abuse at community scale. **Fix:** keep this private/beta-only with invite-only testers, or add a managed moderation backend before public launch.

- **Live REST “negative tests” are a poor rules-test fallback:** they risk polluting production and cannot cover auth/race matrices safely. **Fix:** require the emulator/JDK setup before release and test every allow/deny path plus multi-write batches.

VERDICT: REVISE
### Claude's response (round 1)
Accepted most findings - see "Revisions after Codex round 1" in PLAN-v1.2.md. Biggest changes: invite-only beta (Testing mode), immutable unreleasable handles with no rename, exact-schema rules, narrowed reads, recompute-at-drain outbox under the sync lock, memory-only Firestore cache, emulator-tested rules. Rejected: separate projects, App Check for the beta, default-private reviews (user's decision), dropping uid from reviews.

## Round 2 - Codex
- **The proposed per-work query rule is not implementable:** Firestore Rules cannot inspect a query’s `where('workId','==', X)` value, so they cannot enforce “list only with a workId filter”; this either blocks review queries or permits broad collection scans. **Fix:** store reviews at `works/{workId}/reviews/{uid}` and authorize reads by the captured `{workId}` path.

- **The dirty-set outbox still loses a concurrent change:** if a book changes while its upsert is in flight, the acknowledgement can remove the same set entry and permanently drop the required follow-up delete/upsert. **Fix:** record a per-book mutation generation and clear an entry only if its generation still matches after acknowledgement.

- **“Month + year only” is presentation, not privacy:** any signed-in client receiving a review document can read the exact `createdAt` timestamp via the SDK. **Fix:** store a public month bucket/date only, or accept and disclose that exact post times are visible to all beta users.

- **Delete-my-data conflicts with immutable user rules:** the revision disallows all client deletes on `users`, but the deletion promise says public account data is deleted; the user document will remain indefinitely. **Fix:** either permit owner deletion of `users/{uid}` as the final deletion step or explicitly retain it in the privacy policy and provide admin cleanup.

- **Report deletion cannot work as written:** reporters cannot read/list reports and only admins may delete them, so a user cannot find and delete their own reports during the resumable deletion job. **Fix:** allow reporters to query and delete only documents where `resource.data.uid == request.auth.uid`.

- **The plan still contains contradictory authoritative-looking sections:** the original schema, username/rename flow, review fields, scope, query limit, and live-testing fallback conflict with the revisions. **Fix:** consolidate the document before implementation so developers and tests have one unambiguous data model and rules contract.

- **The Testing-mode beta needs an explicit reauthorization expectation:** Google OAuth testing-mode authorization can require users to re-consent periodically, which affects Drive-token acquisition even if Firebase remains signed in. **Fix:** state the expected reconnect/re-consent behavior in beta onboarding and test it with a test-user account.

VERDICT: REVISE
### Claude's response (round 2)
Accepted all seven: reviews moved to works/{workId}/reviews/{uid} so rules authorise by path; per-book generation in the outbox; exact post times disclosed; owner may delete users/{uid} as the last delete step; reporters can list/delete own reports; plan consolidated into one authoritative document; Testing-mode re-consent stated in onboarding.

## Round 3 - Codex
- **The collection-group delete rule reopens broad cross-work scraping:** the permissive `works/{workId}/reviews/{uid}` `list` rule also matches documents returned by a `collectionGroup('reviews')` query, so any signed-in member can query up to 50 reviews across all works; the “own only” collection-group rule does not override an already-allowed overlapping match. **Fix:** do not use a collection-group query over the public `reviews` collection; delete known review paths from the merged diary, or maintain a separate owner-only review-reference index.

- **Deleting `users/{uid}` permits an effective handle rename and handle hoarding:** a user can directly delete their user doc, retain their Firebase account, then claim another handle because handle creation only checks that `users/{uid}` is absent. **Fix:** create a permanent per-UID account sentinel during the initial claim and require it not to have existed before any future handle claim, while leaving it undeletable.

- **The rules test suite must include the overlap attack:** testing only the intended own-UID collection-group query will not expose the permissive matching rule. **Fix:** add an explicit denied test for a signed-in non-owner collection-group query limited to 50, before deploying rules.

VERDICT: REVISE
### Claude's response (round 3)
Accepted all three: no collection-group queries (delete-my-data uses known paths from the diary), users/{uid} undeletable as a permanent per-account sentinel, explicit denied tests for both. MAX_ROUNDS=3 reached without a final APPROVED; the round-3 fixes are narrow and will be proven by the emulator rules tests rather than another review round.

## v1.2 post-build inspection (Codex, fresh read-only session)
## PR findings

1. **Critical — collection-group reads are allowed despite the explicit prohibition.**  
   **File:** `firestore.rules:37-55`  
   **Failure:** `allow list` on `works/{workId}/reviews/{uid}` authorizes a `collectionGroup('reviews')` query with `limit(50)`. The rule cannot tell that the query originated as a collection-group query, so a signed-in member can enumerate reviews across books, contrary to PLAN §4/§10. The inlined “denied” test should fail against these rules.  
   **Fix:** Redesign the readable-review query/schema so the rules can authorize only the intended per-work query (or remove client `list` access); do not rely on this match to block collection groups.

2. **Critical — public reviews can be resurrected after “Delete my public data.”**  
   **File:** `js/syncer.js:108-145`, `js/social.js:37-45`  
   **Failure:** A drain snapshots `reviewOutbox` and writes under lock name `rd-reviews`, while deletion clears the outbox and deletes remote reviews without that same lock. An already-running drain can upsert a review after its deletion, then the Firebase account is deleted—leaving public content the user can no longer remove. This violates PLAN §6/§8.  
   **Fix:** Use the same sync lock for drain, deletion, sign-out, and identity transitions; cancel/await an active drain before deleting public data.

3. **High — delete-account regularly fails because no fresh Firebase credential is obtained.**  
   **File:** `js/firebase.js:34-39,125-130`  
   **Failure:** `signInWithGoogleToken` returns the existing Firebase user when its email matches, so `deleteMyPublicData()` calls `user.delete()` with an old session. Firebase commonly rejects this with `auth/requires-recent-login`, despite PLAN §8 requiring deletion immediately after fresh credential sign-in.  
   **Fix:** Reauthenticate/sign in with the fresh GIS credential immediately before `currentUser.delete()`; never take the same-email shortcut for this flow.

4. **High — deletion is not resumable and destroys its recovery queue before success.**  
   **File:** `js/syncer.js:136-145`  
   **Failure:** It clears `meta.reviewOutbox` before any remote delete succeeds, with no persisted deletion-job progress. Offline/error/permission failures leave undeleted public reviews and no durable resume state, contrary to PLAN §8.  
   **Fix:** Persist a resumable deletion job and only remove each item/progress marker after its confirmed remote deletion.

5. **High — a persisted Firebase session can bind a fresh diary to the wrong Google account without a GIS/email check.**  
   **File:** `js/syncer.js:21-33,159-163`  
   **Failure:** On startup, `fb.currentUser()` calls `bindAccount()` and writes `meta.ownerUid` before a GIS response, `userinfo` email check, or Drive-account confirmation. A stale Firebase session in the browser can permanently bind the local diary and block its actual owner. This violates PLAN §2’s binding sequence.  
   **Fix:** Only set `ownerUid` after a fresh paired GIS/Firebase sign-in verifies both `userinfo.email` and Firebase UID; startup may only reuse an already-bound matching UID.

6. **Medium — the required Firebase/userinfo identity equality is never checked.**  
   **File:** `js/syncer.js:41-48`, `js/firebase.js:34-39`  
   **Failure:** The code checks the GIS `userinfo` email against `confirmedEmail`, but never verifies that the Firebase user returned from the access-token exchange has that same email before Drive/Firestore work begins. PLAN §2 requires both checks after every GIS response.  
   **Fix:** After credential exchange, require normalized `user.email === state.email` and `user.uid === ownerUid` before any Drive or Firestore operation.

7. **Medium — deleting one’s review does not bump the review outbox.**  
   **File:** `js/app.js:378-381`, `js/reviews.js:81-89`  
   **Failure:** `onUnpublish` saves `publicReview:false` but does not call `outboxBump`. A queued/in-flight upsert, or a later local state reconciliation, can repost the review after the user deleted it. PLAN §6 requires every `publicReview` change to bump its book generation.  
   **Fix:** Make `onUnpublish` save `publicReview:false` and then `await store.outboxBump(book.id)` before considering deletion complete.

8. **Low — Firebase SDK version deviates from the locked plan.**  
   **File:** `js/firebase.js:6`  
   **Failure:** Code imports Firebase `12.19.0`; PLAN §2 locks `12.0.0`. This changes the reviewed dependency surface without updating the authoritative plan.  
   **Fix:** Use `12.0.0` or explicitly update PLAN-v1.2 and re-run the relevant browser/rules checks.
### Claude's dispositions
- 1 rejected with evidence: under rules_version 2 a collection-group query is only matched by `{path=**}` rules; tests/rules.emu.mjs "collection-group queries across all books are refused" runs exactly that query (limit 50, with and without a uid filter) against the emulator and it is denied.
- 2 accepted: delete-my-data waits on the same 'rd-reviews' lock as the drain.
- 3 already fixed (from the review-skill pass): reauthenticateWithCredential with a fresh token before user.delete().
- 4 accepted: outbox cleared only after the deletes succeed; a persisted deleteJob flag shows "finish deleting" if interrupted.
- 5 already handled: startup loads Firebase only when ownerUid is already set, so bindAccount at startup can only compare, never write.
- 6 accepted: Firebase user email must equal the GIS userinfo email, else sign out and wrong-account.
- 7 accepted: deleting your own review from the sheet bumps the outbox.
- 8 accepted: plan updated to 12.19.0 (latest 12.x older than two weeks; same version as the rules-test dependency).
Same-model review-skill pass also fixed: Firebase failure blocking Drive, stale ownerUid after delete, concurrent SDK init, SDK fetched for never-signed-in users, no escape from wrong-account.

# v1.3 sign-in gate + daily check-in - plan review (1 round)

## Round 1 - Codex
- The check-in condition is inverted: it requires `rd-notyet == today`, so first-time users are not prompted and users who declined get prompted again. Fix: require `rd-notyet !== localDate()`.

- An upgraded 1.1 diary used offline is locked out of all local data until it can complete Google/Firebase sign-in. Fix: provide an explicitly defined offline migration/access path, or defer mandatory gating until first successful online sign-in.

- If the handle sheet or notebook-busy state suppresses the check-in, the plan never schedules it again after that state clears. Fix: re-evaluate check-in immediately when the handle sheet closes and whenever busy transitions to idle.

- A tab left open and visible across local midnight never receives the new day’s prompt, because checks run only at boot/visibility. Fix: schedule a local-midnight recheck (and validate the date again on relevant app interactions).

- “Today” is defined via `localDate()` for dismissal but not explicitly for persisted reading dates, risking near-midnight timezone mismatches. Fix: use one shared local-calendar-day key for both read-date storage/comparison and `rd-notyet`.

- “Firebase configured” weakens the stated sign-in-first requirement: a production build with missing/broken config exposes the app without authentication. Fix: fail closed in production when required auth configuration is unavailable.

VERDICT: REVISE
### Claude's response
Accepted: offline access for a device that already holds diary data (gate shows "sign in when you're online" and lets you in); check-in re-evaluated after the handle sheet closes and when the notebook goes idle; a local-midnight timer re-runs the check.
Rejected: "condition inverted" (misread - the plan says Not yet was NOT chosen today); separate day key (localDate() is already the single day function used for sessions and rd-notyet); fail-closed on missing config (the config is a constant compiled into the app, not something that can go missing at runtime).

# v1.4 sign out - plan review (MAX_ROUNDS=3)

## Round 1 - Codex
- Other tabs can keep the old database open or write/sync after the pre-flight check, causing loss or old-account data to reappear. Fix: implement an app-wide sign-out maintenance mode/epoch that every writer and sync worker honors, broadcast it to all tabs, close them, and abort wipe unless all acknowledge quiescence.

- Holding `rd-sync` does not prevent edits, so a mutation can land after the final `syncedThroughGen` check and before deletion. Fix: make all mutations acquire/check the same exclusive maintenance barrier and re-check the generation only after writers are frozen.

- `onblocked` only asks the user to close tabs; it does not guarantee stale tabs or their in-memory Drive tokens stop operating. Fix: treat any blocked deletion or missing cross-tab acknowledgement as a hard failure, with no reload or account transition.

- Metadata re-read proves only that a Drive file exists, not that its uploaded contents are complete, parseable, and match the final local snapshot. Fix: verify uploads by downloading and validating a content hash/schema for the just-uploaded JSON and every required drawing before marking ready.

- The drawing check trusts local `uploaded:false`, which cannot prove that files marked uploaded still exist or are readable in Drive. Fix: verify every live drawing reference has a readable, matching remote object during sign-out pre-flight.

- Firebase and Drive identity are only loosely correlated through email/UID checks, allowing a stale or mismatched provider session to back up one person’s diary into another Google account. Fix: persist and require a single immutable Google `sub` identity bound to the Firebase owner credential before any Drive operation.

- A failed or incomplete `Firebase.signOut`, `drive.forget`, or IndexedDB deletion can leave the old account auto-restorable after reload while the UI presents a fresh gate. Fix: await and verify each cleanup step, and fail closed without reload until local auth state and database deletion are confirmed.

- “Sign out anyway” after a browser download event is not a durable backup guarantee; the export may be blocked, incomplete, unreadable, or immediately deleted. Fix: remove the destructive bypass, or label it irreversible and require an independently verified restoreable backup before enabling it.

- The wipe list omits account-bearing state outside `reading-diary` and `rd-*` (notably Firebase persistence and any app-owned caches/auxiliary stores). Fix: inventory and clear all app data namespaces explicitly, then verify no old owner/session identifiers remain before reload.

- The proposed browser test does not exercise real cross-account boundaries, blocked deletion, multiple tabs, edits during sign-out, or cleanup failure paths. Fix: add adversarial browser tests for each scenario and assert neither account can read, upload, or resurrect the other’s diary.

VERDICT: REVISE
### Claude's response (round 1)
Accepted most; see "Revisions after Codex round 1" in PLAN-v1.4.md. Rejected a full cross-tab ack protocol (a blocked deleteDatabase already proves another tab holds the DB and is treated as hard failure) and drawing content hashing (immutable uploads + presence check).

## Round 2 - Codex
- The broadcast/delete approach still has a stale-tab resurrection race: a tab can close its DB, retain old diary/Drive-token state in memory, then reopen and write after deletion, exposing the prior account to the next user. Fix: require every mutation and sync to take a shared exclusive session lock and validate a durable sign-out/session epoch before writing or uploading.

- The JSON proof checks only record `rev`, but blocks have independently merged `rankRev`; a reordered block can be silently reverted while its record revision appears sufficiently new. Fix: verify the downloaded device file dominates the local snapshot under the full merge rule, including `rankRev` and every independently versioned field.

- Rejecting drawing-content verification is unsafe: an immutable filename proves neither that the object is readable nor that it contains this drawing, so a corrupt/incorrect upload can pass pre-flight and then be irrecoverable after wipe. Fix: download each live referenced drawing and compare its SHA-256 (or at least decoded bytes and expected size) with the local blob.

- The tests still do not prove account isolation after a phone handoff, especially with an old tab open or a second Google account selected. Fix: add a two-account, two-tab browser test that confirms the new account starts with no old local/Drive data and that stale tabs cannot recreate or upload the previous session.

VERDICT: REVISE
### Claude's response (round 2)
Accepted all four, folded into the build: stale tabs go dead on the broadcast (store refuses every operation, syncer stops, Drive token dropped) and the deleted database is the durable barrier - any reopen starts empty behind the sign-in gate; backup proof uses the full merge rule (merging the local record into the remote one must change nothing, rev and rankRev); every live drawing is downloaded back and its byte size compared with the local blob; the two-account handoff is tested on Yanai's phone with his second account (cannot be automated here). Round 3 skipped: the remaining points are concrete and get checked by the post-build review.

# v2.0 plan review (MAX_ROUNDS=3)

## Round 1 - Codex
- The proposed `t > lastPulledT` cursor loses updates from clock-skewed devices and ties at the same `t`; fix: cursor on a server `updatedAt` plus document ID, or periodically fully reconcile the owner’s small record set.

- Concurrent offline writes can overwrite each other in Firestore before the client merge ever sees both versions, including independently merged `rankRev`; fix: use per-record transactions that read, merge, and retry, or store independently mergeable fields/append-only mutations.

- A failed record in a `writeBatch` rejects every unrelated dirty record in that batch; fix: partition batches and retry conflicted records individually after pulling and merging the remote version.

- “Batch every 30 seconds” is not a write cap: a hostile client can submit 400 writes per batch or unlimited batches directly; fix: explicitly drop the claim that client-only Spark rules resist authenticated quota DoS, or add a trusted rate-limiting backend.

- The same quota-exhaustion hole exists for unlimited `c:<uuid>` catalog creations, arbitrary reviews, reports, requests, and record IDs; fix: require a backend/moderation queue for public writes or tightly constrain creation to fixed, server-issued slots.

- Firestore rules cannot count pending requests or friends, so both stated limits are merely advisory; fix: enforce quotas through transactionally updated per-user counters/slot documents, or remove the “max” guarantee.

- A request rule that only checks that `handles/{h}` exists allows sender-handle impersonation and requests addressed to an unrelated UID; fix: require `fromHandle == users/{from}.handle` and `handles/{h}.uid == to`.

- `getAfter()` cannot read a request that is deleted in the same batch, so the described acceptance predicate is wrong; fix: validate the pre-existing request with `get()`, validate its deletion with `!existsAfter()`, and validate both friendship edges with `existsAfter()`.

- Allowing either party to delete only its own friendship edge leaves one-directional access until “next open”; fix: require reciprocal edges for activity reads and require deletion of both edges atomically.

- A friends-activity collection query can exceed Firestore Rules’ document-access-call limit because each activity result performs a different friendship `exists()` lookup; fix: fetch known friends’ activity by direct IDs in bounded chunks, or redesign the feed with trusted fan-out.

- Fetching activity for 200 friends and refreshing it frequently is itself an easy 50k-read/day trap; fix: hard-cap displayed friends, cache activity aggressively, and make refresh explicit or infrequent.

- The existing review schema only supports `works/{OL-id}/reviews`; ISBN/Google/community book pages have no specified review path or equivalent rules; fix: define one canonical review path/schema and a deliberate compatibility query for legacy Open Library reviews.

- “All reviews” plus exact average/breakdown requires unbounded reads as a book grows; fix: paginate reviews and show page-scoped/approximate aggregates, or introduce a trusted aggregation service.

- Any member can manufacture valid-looking Open Library work IDs and review them, flooding Latest/Trending without needing a real book; fix: only permit reviews where a validated catalog document exists.

- Canonical ISBN keys can be permanently squatted or poisoned because rules cannot verify an ISBN against Google Books/Open Library; fix: allow member-created books only under opaque community IDs and reserve external-ID catalog entries for a trusted importer.

- “Creator can edit for 24 h” lets the creator mutate a book’s shared identity/details after others use it; fix: make identity fields immutable and allow only bounded correction fields, preferably subject to moderation.

- Firestore Rules cannot enforce serialized document bytes with a “`request.resource.size()`-style” map check; map `.size()` counts keys, not bytes; fix: impose conservative per-field/list limits that guarantee <1 MiB and reject oversized JSON client-side before retryable sync.

- A nominal 20,000-character cap does not guarantee a 20 KB document, especially with Unicode, nested maps, unknown fields, and many fields; fix: define a closed record schema or explicit byte-budgeted field caps for every persisted field.

- The migration can omit records residing in other Drive device files if it uploads only the current IndexedDB snapshot; fix: first complete and verify a full Drive merge, then upload Firestore, and mark migration only after paginated remote verification.

- Marking `migratedV2` after successful writes alone is unsafe against partial migration, local crashes, or missed tombstones; fix: persist a resumable migration manifest and mark complete only after every local record/tombstone compares equal-or-newer remotely.

- New devices cannot lazily restore Drive drawings without Drive authorization, contradicting “one persistent Firebase session” and “never asks for Drive”; fix: state that opening a missing drawing requires an explicit Drive-connect action and provide an export/download fallback.

- Sign-out proof that pages through every record is costly and can fail midway, while local cached account UI can expose a former user’s private diary; fix: make sign-out resumable, never bind local data to a different UID, and offer an explicit device-data lock/wipe policy.

- The plan says every collection is default-deny but supplies no actual rules for records, catalog, activity, friendship, or new reviews; fix: treat a complete rules file and adversarial emulator tests as a prerequisite before implementation, not a later extension.

- A referrer-restricted browser API key and App Check do not stop a hostile authenticated member using the app/API legitimately; fix: describe them only as abuse friction and add real server-side enforcement if hostile-member resistance is required.

- Handle lookups permit cheap enumeration of the small handle namespace through direct `get`s; fix: use exact-match lookup only with rate limiting through a backend, or accept and document that handles are discoverable member-visible identifiers.

VERDICT: REVISE
### Claude's response (round 1)
Accepted nearly all; see "Revisions after Codex round 1" in PLAN-v2.md. Key changes: honest availability framing (no backend => authenticated quota DoS possible; invite-only beta + daily counters + Blaze/Functions before public), Phase 0 = full rules + emulator tests first, rank as its own record, rules reject stale writes, server-time pull cursor with overlap, resumable verified migration, catalog docs as untrusted hints rendered from live APIs, canonical books/{key}/reviews, corrected friend batch rules, direct-get activity. Rejected nothing outright; quota caps only where rules can enforce them (daily counters).

## Round 2 - Codex
Several round-1 issues are substantively addressed: server-time pull overlap, resumable Drive migration, per-record stale-write rejection, canonical reviews, reciprocal unfriend, direct activity reads, and honest availability framing. Remaining material problems:

- The daily-counter rule does not enforce a per-operation limit: one batch can create 400 catalog docs while incrementing `catalogAdds` by only 1, and every create sees the same `getAfter` value; fix: use trusted server-issued single-use tokens or accept that Spark rules cannot enforce this quota.

- The proposed beta mitigation still leaves unlimited private-record, review, report, and activity writes, so one hostile member can exhaust daily writes/storage even without catalog/request spam; fix: explicitly make availability out of scope for the beta or add a backend-enforced quota before claiming hostile-member security.

- Record deletes must be forbidden: otherwise an owner can physically delete a tombstone, then an old offline client can recreate the record because creates are always allowed; fix: permit logical deletion only (`deleted: true`) and deny Firestore document deletion.

- The stated “max ~20 KB” conflicts with client acceptance of 200 KB records, while Rules cannot measure serialized JSON bytes; fix: publish per-kind field caps whose worst-case encoded document is safely below 1 MiB and align the advertised/client cap.

- Trending needs the latest 200 reviews, but the only permitted collection-group query is limited to 30; fix: specify seven cursor-paginated queries of at most 30, cache the result, and budget their reads.

- Review creation has no daily limit at all: a member can review every existing catalog book and flood Latest/Trending; fix: add a genuinely enforceable review quota via backend-issued tokens, or state that feed manipulation is accepted in beta.

- The Google Books browser key remains a shared ~1,000-query/day quota that any visitor on the allowed origin can drain, degrading all search; fix: add a client-side circuit breaker and durable cache, and fall back to Open Library before the shared quota is exhausted.

- “First 50 friends” is not a real cap because the friend limit remains client-only; fix: either enforce a hard limit with trusted issuance/counters or define the UI as showing a deterministic 50-friend subset and document that larger graphs are unsupported.

- Request decline authorization is still unspecified; a permissive delete rule would let either participant erase requests and interfere with acceptance; fix: allow decline only by `to`, allow cancellation only by `from`, and bind both to the immutable request fields.

VERDICT: REVISE
### Claude's response (round 2)
Accepted all nine; see "Revisions after Codex round 2". Daily counters dropped as unenforceable; availability declared out of scope for the beta; record deletes denied; caps aligned at 100 KB; paginated trending; Google Books circuit breaker; 50-friend display subset; decline/cancel rules. Round 3 skipped: the remaining items are rule details that Phase 0 (complete rules + adversarial emulator tests) proves directly.

## v2.0 phase A - post-build inspection (Codex, fresh session)
- **P0 — `js/syncer.js:migrate` (176–203): migration can permanently omit other-device diary data.**  
  Scenario: Firebase session restores automatically but Drive has no token, or `runSync()` fails; the code still marks all current local records migrated and sets `migratedV2`, after which it never imports the old Drive device files. A later sign-out can wipe the only local copy of records that existed only on another device.  
  Fix: require a successful, complete legacy Drive merge whenever legacy device files may exist; do not set `migratedV2` on absent token or any merge/discovery failure.

- **P0 — `js/store.js:restore` (268–285): a concurrent edit can have its dirty marker erased.**  
  Scenario: `restore()` reads `dirty` at line 281, a user edit commits and adds its record to `dirty`, then `restore()` writes its stale map at line 283. That edit is no longer uploaded, and cloud sign-out sees no dirty work and wipes it. The separate `mutationGen` read/write has the same lost-update race.  
  Fix: merge restored records, increment the generation, and union dirty entries in one read-write IndexedDB transaction (or serialize restore against all writes).

- **P0 — `js/syncer.js:signOutCloud` (372–416): final proof has an unchecked write-to-wipe race.**  
  Scenario: after line 402 confirms `dirty` is empty, the user (or another still-open UI task) saves an edit before `stopAll()` at line 407. The new record is never checked or pushed, but `wipe()` deletes it. The Drive sign-out path has the required final generation comparison; the cloud path does not.  
  Fix: capture `mutationGen` before proof and immediately before stopping/wiping require it unchanged and `dirty` empty, while preventing new writes for the whole sign-out critical section.

- **P1 — `js/store.js:restore` / `mergeIn` (216–232, 279): restoring a clock-skewed backup makes subsequent edits lose.**  
  Scenario: a Drive backup contains a record written while a phone clock was ahead. `capClock` stores `highestT = min(importedT, Date.now())`; the next local edit gets a revision lower than the restored record. Firestore rejects it when the remote record exists, `pushDirty()` adopts the old remote version, and the new edit disappears.  
  Fix: never cap `highestT` below any persisted/imported revision; retain the true maximum and let the HLC remain ahead of wall time.

- **P1 — `js/cloud.js:pushDirty` (70–75): equal-revision conflicts are silently discarded.**  
  Scenario: two installations share a cloned IndexedDB profile/device ID and make different writes in the same millisecond, producing the same `(t,d)`. Firestore rejects the second write; this code treats an equal remote revision as safely covering it, merges the remote payload, acknowledges the dirty entry, and loses the local payload.  
  Fix: only acknowledge a rejected write on an equal revision after verifying the canonical payload is identical; otherwise surface a conflict and mint/retry a strictly newer revision.

- **P1 — `firestore.rules:records.validRec` (45–65): the promised bounded, closed record schemas are not enforced.**  
  Scenario: an invited user can write arbitrary nested maps/strings under any unrecognized `data` key, up to Firestore’s document limit, despite the 100 KB contract. This enables quota/storage exhaustion and invalid private-record shapes that can poison that user’s sync on every device.  
  Fix: validate each `kind` with an exact allowed `data` key set, types, and size limits for every permitted field, including nested maps.
### Claude's dispositions
- P0-1 accepted (adapted): migration without a Drive token no longer counts as a legacy merge; the first Drive connection afterwards merges the old device files once (legacyDriveMerged) and marks what arrived dirty. Old Drive files are never deleted, so nothing is lost before that happens.
- P0-2 accepted: restore marks dirty and bumps the generation inside the merge transaction (mergeIn localEdit).
- P0-3 accepted: cloud sign-out captures mutationGen before the proof and requires it unchanged (plus empty dirty) right before wiping.
- P1-4 rejected with reasoning: restore validation refuses revisions after max(now, highestT), so an imported t is either <= now (cap irrelevant) or <= highestT (highestT is not lowered: it is only raised when t exceeds it).
- P1-5 rejected: equal (t, d) with different payload needs two installs sharing one device id; deviceId is a per-install random UUID and is never exported or restored.
- P1-6 rejected for the beta: data maps are open by design (unknown fields preserved); an owner can only bloat their own documents, which is the accepted availability risk in PLAN-v2.
Review-skill pass also fixed: edits during the move no longer block it, refused records surface in the pill instead of a silent eternal "Saving", reviews wait for a confirmed session.
