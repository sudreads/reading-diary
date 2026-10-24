# Reading Diary - pre-launch security checklist

Checked 2026-10-24 against a 20-point "before you launch" list. Architecture: static site on
GitHub Pages, private diary on the phone + the user's own Drive appDataFolder, public reviews in
Firestore protected by `firestore.rules` (23 emulator tests in `tests/rules.emu.mjs`).

| # | Item | Status |
|---|---|---|
| 1 | Hide API keys | The Firebase web key and OAuth client id are public by design (they identify the project, they don't grant access). **To do (owner):** restrict the browser key to `https://sudreads.github.io/*` and `http://localhost:8790/*` in Google Cloud → Credentials. |
| 2 | Purge Git secrets | No secrets in tracked files or in the public repo's history (scanned for private keys, GitHub/Slack/OpenAI tokens, OAuth client secrets, refresh tokens, emails). |
| 3 | Use public DB key | Only the public web key is in the client. No service-account key exists anywhere in the repo. |
| 4 | Row-level security | Firestore rules: per-document checks on every path; default deny. |
| 5 | Encrypt sensitive data | The private diary never reaches our server. Drive and Firestore encrypt at rest; all traffic is HTTPS. |
| 6 | Server-side auth | Every Firestore allow requires `request.auth`; enforced by Google's servers, not the UI. |
| 7 | Lock record access | Reviews writable only at `works/{workId}/reviews/{yourUid}`; reports readable only by reporter or admin; user docs readable only by their owner. |
| 8 | Block field tampering | Exact key sets on create, `affectedKeys().hasOnly(...)` on update, immutable workId/uid/handle/createdAt, server timestamps only. |
| 9 | Secure session cookies | No cookies. Firebase keeps its session in IndexedDB; the Drive token lives in memory only. |
| 10 | Hash passwords | No passwords: Google sign-in only. |
| 11 | Rate limit login | Login is Google's (built-in abuse protection). Review edits throttled to one per 10 s per review in the rules; one review per person per book; one report per person per review. |
| 12 | Bot protection | OAuth app in Testing: only invited test users can sign in at all. App Check is the step before opening to the public. |
| 13 | Parameterize queries | Firestore SDK queries only; no string-built queries. |
| 14 | Validate all input | Rules validate types, lengths, ranges and formats server-side; backups and synced files validated client-side before any write. |
| 15 | Escape user content | All user text rendered with `textContent`; no `innerHTML` with data; CSP blocks inline scripts. |
| 16 | Restrict file uploads | Drawings only, webp, capped at 1.5 MB, stored in the user's own Drive. Nothing is uploaded to our database. |
| 17 | Trim API responses | Review documents hold only workId, uid, handle, rating, text and timestamps. No email or profile data is ever written. |
| 18 | Security headers | GitHub Pages can't set custom headers. CSP and referrer policy are set by `<meta>`; framing is refused in JS (no X-Frame-Options possible); HSTS comes from github.io. |
| 19 | Force HTTPS | Enforced in the GitHub Pages settings (`https_enforced: true`). |
| 20 | Scan dependencies | The shipped app has no npm runtime dependencies (`npm audit --omit=dev`: 0). Firebase SDK pinned to 12.19.0 from gstatic. Dev-only tooling (firebase-tools, rules-unit-testing) has audit findings; it runs only on this PC for tests and is never deployed. |
