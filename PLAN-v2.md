# Plan: Reading Diary 2.0 - low friction, a real book catalog, Explore, friends
_Locked via claudex-loop interview, Claude + Yanai, 2026-10-26. Yanai delegated the data,
storage and security decisions to Claude ("I trust you... storage, security, very low friction").
Builds on PLAN.md (local-first records, revisions, merge), v1.2 (Firebase, handles, reviews rules),
v1.3 (gate, check-in), v1.4 (sign out)._

## Goal
The core stays: **private diary, public reviews, daily streak**. 2.0 removes friction (never
"sign in" or "connect Drive" again once signed in), makes every book findable (big catalog plus
"add it yourself" for everyone), adds an **Explore** tab for books and their reviews, and lets
classmates become **friends by @name** (friend request, mutual). Not a social network: no
followers, likes, replies or notifications. 100-user invite-only beta on the Firebase free plan.
Security must hold against a hostile signed-in member.

## Decisions from the interview
- Tabs: **Home** (streak, today's book, check-in) · **Explore** (search, trending in the app,
  latest reviews, friends' activity) · **My Books** (shelf, notebooks, comments, trophy road) ·
  **Me** (@name, Gmail, friends, settings, sign out).
- Book page: description + details, average rating + all reviews, add to my books.
- Friends: send a request to an @name; both must accept; friends see each other's activity.

## A. Friction and storage (Claude's call)
1. **Fix the "signed out" flash:** account UI derives from local `ownerUid`/`ownerEmail`/cached
   `handle` immediately; Firebase state only refines it. Never shows "Sign in" for a bound phone.
2. **Private diary moves into the reader account** (Firestore), so one persistent Firebase session
   is enough - no Drive token for normal use:
   - `users/{uid}/records/{kind}_{id}`: `{kind, id, data, t, d, deleted}` where `data` is the
     record (book/block/session) and `(t, d)` the existing revision (rankRev kept inside data for
     blocks; merge rule unchanged). One document per record, max ~20 KB (text caps already 20 000
     chars). Owner-only rules.
   - **Sync:** local IndexedDB stays the main copy (offline first). Push: changed records batched,
     at most one batch every 30 s while editing and on hide (writeBatch, <= 400 docs). Pull: on open
     and every few minutes while visible, `where('t', '>', lastPulledT)` ordered by t, merged with
     the existing merge rule; `lastPulledT` per device in meta. Same dirty-generation guarantees as
     today (`syncedThroughGen` only after the batch commit resolves).
   - **Drawings stay in each user's own Google Drive** (shared DB space stays small). Drive is only
     needed when a drawing is not yet uploaded or a drawing from another device is missing; then a
     small "Back up 2 drawings - tap" chip appears. Opening the app or writing never asks for Drive.
   - **Migration on first 2.0 open:** push every local record to Firestore (batched), keep the old
     Drive device files untouched as an archive; mark `migratedV2`. New phones restore from
     Firestore; drawings from Drive lazily as today.
   - Budget (free Spark: 1 GiB, 50k reads/day, 20k writes/day): text diary ~0.5 MB/user/year ->
     100 users ~50 MB/year. Writes: batched 30 s => an hour of active writing ~ 120 writes; 100
     daily users ~ 5-8k/day. Reads: pull is incremental (only changed docs).
3. Sign-out (1.4) keeps working: proof becomes "every local record exists in Firestore with an
   equal-or-newer revision" (paged reads of own records) plus the existing Drive drawing check.

## B. Catalog: every book findable
1. Search order: **Google Books API** (keyed browser key, referrer-restricted; ~1 000 queries/day
   project default) -> **Open Library** fallback when Google Books errors/429s or returns nothing ->
   **community catalog** (Firestore prefix search on `titleLower`).
2. **Canonical book key** shared by reviews, catalog, trending:
   `isbn:<isbn13>` when any ISBN is known; else `gb:<volumeId>`; else `ol:<OL...W>`; else
   `c:<uuid>` for community-added. Existing 1.x reviews live at `works/{OL...W}`: kept readable and
   treated as key `ol:<OL...W>`; when the same book is later seen with an ISBN, the book page reads
   both paths (no data move).
3. **Add a missing book:** form (title, author, optional ISBN, pages, cover image URL from
   Google/Open Library only) -> `catalog/{bookKey}` doc `{title, titleLower, author, isbn13?,
   pages?, coverUrl?, createdBy, createdAt}`; findable by everyone; creator can edit for 24 h; admin
   deletion only (no admin UI in 2.0; console).
4. Search UX: one search box, results grouped "Books" with cover/title/author/year, debounced 400 ms,
   cached in-memory for the session (cuts Google quota), "Can't find it? Add it" at the bottom.

## C. Explore + book page
1. **Book page** (`#/book/<key>`): cover, title, author, year, pages, description (Google Books,
   sanitised to text), average stars + count + rating breakdown, all reviews (newest first, load
   more), "Add to My Books" (want / reading / finished).
2. **Explore home:** search box; **Latest reviews** (collection-group query on `reviews`, newest 30,
   rules allow list only with `limit <= 30`); **Trending** = books with the most reviews among the
   latest 200 reviews (client-side count; no counters to forge); **Friends' activity** (D).
3. Review docs gain `bookKey`, `title`, `author`, `coverUrl` (display hints validated by rules:
   string lengths, cover URL host allow-list) so feeds render without extra lookups.

## D. Friends by @name
1. `friendRequests/{fromUid}_{toUid}` `{from, to, fromHandle, createdAt}`: create only by `from`,
   only if the target handle exists (`handles/{h}`), not to self, one per pair; readable by the two
   people; deleted on accept/decline.
2. Friendship = two docs `friends/{uid}/list/{otherUid}` written in one batch by the accepter; rules
   require the matching request to exist (`getAfter` request deleted in the same batch and
   `existsAfter` both sides). Either side can delete their own side; the other side is cleaned on
   next open.
3. **Activity card** `activity/{uid}` `{handle, currentBook {key,title,coverUrl}, streak,
   finishedCount, lastFinished {key,title,rating}, updatedAt}` written by the owner (debounced, on
   change). Readable only by the owner and friends (`exists(friends/{owner}/list/{reader})`).
   Notebook and comments are never part of it.
4. Max 200 friends (rules: client keeps count; soft limit), 20 pending outgoing requests (rules can't
   count - enforced client-side; abuse handled by report/admin).

## E. Security (hostile signed-in member)
- Every collection default-deny; exact key sets on create, `affectedKeys` on update, types and
  lengths everywhere, server timestamps, immutable owner fields.
- Private records: `users/{uid}/records/*` read/write only by `uid`; size cap via string lengths in
  `data` validation for known fields plus `request.resource.size()`-style limits on maps (key count
  <= 30).
- No collection-group reads except `reviews` (limit <= 30, public-to-members by design).
- Display strings rendered with textContent only; Google Books descriptions stripped of HTML to
  text before display; cover URLs only from books.google.com / covers.openlibrary.org hosts.
- Google Books key referrer-restricted; Firebase key referrer-restricted (done).
- App Check noted as the gate before leaving the 100-tester beta.
- Rules test suite extended (emulator) for every new collection, allow and deny.

## Revisions after Codex round 1 (override A-E where they differ)
**Security framing (honest):** rules give strong *confidentiality and integrity* (nobody reads or
changes another person's private diary, reviews, requests or activity). They cannot give
*availability* against an invited member who deliberately spams writes: with no backend on Spark,
quota exhaustion by an authenticated member is possible. Mitigation for the invite-only beta:
per-user daily counters where rules can enforce them (below), report + remove the tester. Before a
public launch: Blaze plan + Cloud Functions for rate limits/aggregates + App Check.

**Phase 0 (before any feature code): complete `firestore.rules` + emulator tests** for every new
collection, allow and deny, including the attacks listed here.

A. Private records
- Path `users/{uid}/records/{kind}_{id}`, closed schema per kind with byte-budgeted caps (text
  <= 20 000 chars, titles <= 500, <= 25 keys), client refuses any record whose JSON > 200 KB.
- Block **rank becomes its own record kind** (`rank_{blockId}` with `{rank}`) so every record has
  exactly one revision `(t, d)`.
- **Rules reject stale writes:** update allowed only if the new `(t, d)` is lexicographically
  greater than the stored one; create always. A rejected write => pull that record, merge, retry
  individually. Batches that fail fall back to per-record writes.
- **Pull cursor on server time:** every write sets `u: request.time` (rules enforce). Pull
  `where('u', '>', lastU - 120 s)` ordered by `u`, page 300; merge is idempotent so the overlap is
  harmless; `lastU` advances to the newest `u` seen.
- **Migration, resumable:** step 1 one-time "Connect Drive to move your diary" (only if Drive has
  device files not yet merged; skipped for diaries that never used Drive) -> full Drive merge;
  step 2 upload all records (incl. tombstones) in batches, progress saved in a manifest; step 3
  verify every local record exists remotely with equal-or-newer `(t, d)`; only then `migratedV2`.
  Old Drive files are left untouched.
- Drawings: a phone missing a drawing shows "Drawing is in your Drive - tap to load" (explicit
  Drive connect), never a blocking prompt.
- Sign-out proof: `syncedThroughGen === mutationGen`, then verify only records with local
  `t > verifiedT` (checkpoint advanced after each successful verify); full verify once after
  migration.
- Local data is never shown to a different uid (existing ownerUid/ownerGoogleSub binding).

B. Catalog
- `catalog/{bookKey}` docs are **existence + display hints only**, immutable after create, never
  trusted for identity: book pages for `isbn:`/`gb:`/`ol:` keys always render from a live Google
  Books / Open Library fetch (cached for the session). Only `c:<uuid>` community books render from
  the catalog doc. No edits (admin delete via console).
- Catalog creation needs a per-user daily counter `users/{uid}/limits/day_{yyyymmdd}`
  (`catalogAdds <= 20`, rules check increment by exactly 1 in the same batch via getAfter).

C. Reviews and Explore
- **One canonical path:** `books/{bookKey}/reviews/{uid}`, same schema/rules as 1.2 plus display
  hints (`title`, `author`, `coverUrl` host-allow-listed). Create requires `catalog/{bookKey}` to
  exist. Legacy `works/{OL}/reviews` stay readable; the book page for an `ol:`/matching key reads
  both and merges by uid (new path wins).
- Latest reviews: collection-group `reviews` list with `limit <= 30` (rule on `{path=**}/reviews`).
  Aggregates are labelled as computed from the loaded reviews; pagination for the rest.

D. Friends
- Request create: `from == me`, `fromHandle == get(users/me).handle`, `get(handles/{toHandle}).uid
  == to`, `to != me`, per-user daily counter `friendRequests <= 30`.
- Accept batch: `get(request)` exists before, `!existsAfter(request)`, `existsAfter` both edges
  `friends/{a}/list/{b}` and `friends/{b}/list/{a}`. Unfriend deletes **both** edges atomically
  (rules let me delete `friends/{other}/list/{me}`). Activity read requires both edges.
- Friends' activity: direct `get` of each friend's `activity/{uid}` (bounded: first 50 friends,
  cached 10 min, refresh on Explore open) - no collection query, so no per-result rule lookups.
- Handles are member-visible identifiers (lookup by exact name); documented in privacy.html.

## Revisions after Codex round 2 (override the above where they differ)
- **Availability is explicitly out of scope for the beta.** No daily counters (a batch can create
  many docs against one increment, so they would be security theatre). Feed/catalog/review spam
  and quota exhaustion by an invited member are accepted risks, handled by removing the tester and
  deleting data in the console. Blaze + Cloud Functions (rate limits, tokens, aggregates) + App
  Check is the gate before going public.
- **Private records are never physically deleted:** rules deny `delete` on
  `users/{uid}/records/*`; deletion is `deleted: true` with a newer `(t, d)`, so an old offline
  phone can never recreate a removed record.
- **Size caps, aligned:** per-kind closed schemas; worst case is the 20 000-char text field
  (<= 80 KB UTF-8) plus small fields, so every record document stays < 100 KB, far below 1 MiB.
  The client refuses any record whose JSON exceeds 100 KB (same number everywhere).
- **Trending:** up to 3 cursor-paginated collection-group pages of 30 (latest 90 reviews), cached
  15 min per device (<= ~90 reads per refresh).
- **Google Books quota:** session cache by query; on any 429/403 the client switches to Open Library
  for the rest of the day (localStorage cooldown), so search keeps working when the shared quota
  runs out.
- **Friends:** the UI shows a deterministic first 50 friends (sorted by handle); larger graphs are
  unsupported in the beta (documented, not enforced).
- **Request delete rules:** decline = only `to`; cancel = only `from`; accept = the batch above
  (`to` only). Request fields immutable (no updates).

## F. Delivery
Ship in phases, each built, reviewed (review skill + Codex inspection), tested, published:
A (friction + private diary in account) -> B (catalog) -> C (Explore + book page) -> D (friends) ->
E (4-tab layout; parts land with C/D).

## Out of scope
Followers, likes, replies, notifications, DMs, public (signed-out) pages, profile photos,
payments, production OAuth launch.
