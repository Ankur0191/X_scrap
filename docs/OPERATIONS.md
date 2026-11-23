# Operations and edge cases

## Authorization

- Keep the original X authorization email and any scope amendments.
- Confirm it explicitly covers browser automation/site scripting, visible post collection, retention, collection frequency and both target profiles.
- Headless mode remains disabled until explicitly within the written permission.
- Stop on any instruction from X to pause, reduce, or terminate collection.

## Authentication / browser profile

- Profile missing: run `npm run auth:setup`; profile data stays under `.local/`.
- Session expired: run `npm run auth:check` and sign in manually in headed Chromium.
- MFA / CAPTCHA / security challenge: complete manually; the collector must not bypass it.
- Browser update mismatch: run `npx playwright install chromium`.
- Profile locked: close all Chromium processes using this profile before restarting.
- Concurrent runs: never launch two jobs against the same persistent profile.
- Cookie expiry: do not infer session validity from cookie timestamps; verify the signed-in X UI.

## Visible timeline collector

- Targets: only enabled handles in `config/competitors.json`.
- Timeline views: Posts and Replies.
- Reposts: only recognized as competitor reposts when visible social context identifies the tracked account.
- Quotes: preserve the visible main text and any separately visible quoted text.
- Media: save visible image alt text and displayed media URL; do not download media bytes.
- Metrics: parse only counts displayed in visible action labels; absent values stay null.
- Pinned posts: may appear in the timeline; no special pin-state guarantee is made yet.
- Duplicate post IDs: deduplicate per tracked competitor, not globally.
- Historical scan: `npm run collect:all` follows the timeline up to the configured scroll safety bound; it does not guarantee the entire account archive exists in the frontend.
- UI changes: if card selectors stop matching, the collector reports no visible cards. Update selectors only against the visible UI, never by discovering hidden endpoints.
- Protected/deactivated/suspended account: stop and record the page state; do not attempt alternate access.
- Rate limit / challenge: stop; no automated retry, proxy rotation, or challenge bypass.
- Partial run: each record is appended as soon as extracted, so a browser crash does not discard earlier records.

## Data pipeline

- Import accepts JSON arrays or JSONL.
- Allowed competitor is checked against `trackedCompetitor`; legacy records use `authorUsername`.
- Duplicate key is tracked competitor plus post ID.
- Invalid dates and non-HTTP(S) URLs are reported per row.
- Media-only posts may have an empty text field.
- Keep output append-only and back up before any schema migration.
- Rotate large output files by date before production scale.

## Recovery

1. Stop the running Node process.
2. Close Chromium windows using the project profile.
3. Run `npm run auth:check`.
4. Re-run the collector in headed mode after the session is confirmed.
5. If the profile is corrupt, close Chromium, back up `.local/browser-profile/`, rename it, and run `npm run auth:setup`.
