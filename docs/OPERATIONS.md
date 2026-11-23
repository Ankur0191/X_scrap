# Operations and edge cases

## Authorization

- Keep the original X authorization email and any scope amendments.
- Confirm it explicitly covers browser automation/site scripting, visible post collection, retention, collection frequency and both target profiles.
- Headless mode remains disabled until explicitly within the written permission.
- Stop on any instruction from X to pause, reduce, or terminate collection.

## Authentication / browser profile

- Profile missing: run `npm run auth:check`; answer yes to launch the manual login child process. The preflight waits for that process to finish.
- Session expired: run `npm run auth:check` and sign in manually in headed Chromium.
- MFA / CAPTCHA / security challenge: complete manually; the collector must not bypass it.
- Browser update mismatch: run `npx playwright install chromium`.
- Profile locked: close all Chromium processes using this profile before restarting.
- Concurrent runs: never launch two jobs against the same browser profile.
- Cookie expiry: do not infer session validity from cookie timestamps; verify the signed-in X UI.

## Visible timeline collector

- Targets: only enabled handles in `config/competitors.json`.
- Timeline views: Posts and Replies.
- Reposts: recognized from the visible social-context label on the tracked profile timeline.
- Quotes: preserve the visible main text and any separately visible quoted text.
- Media: save visible image alt text and displayed media URL; do not download media bytes.
- Metrics: parse only counts displayed in visible action labels; absent values stay null.
- Engagement history: `engagement-snapshots.jsonl` records a snapshot when counts change or the configured snapshot interval elapses (default six hours). It records visible counts, not ground-truth lifetime totals.
- Pinned posts: the `isPinned` field is a best-effort visible-text indicator, not a guarantee.
- Duplicate post IDs: deduplicate per tracked competitor, not globally.
- Latest-first scan: does not stop on a single overlapping screen; it stops after the configured number of consecutive screens with no newly collected posts.
- Thread queue: newest in-window root posts are tested first; progress and reply IDs persist across runs.
- Thread status: `newRepliesCaptured` is the number newly appended in that run; `visibleReplyCount` is the unique visible reply cards seen in that scan.
- Thread authors: conversation records keep competitor-authored replies separate from replies by external public accounts. An external account is not automatically a customer.
- Historical scan: `npm run collect:all` follows the timeline up to the configured scroll safety bound; it does not guarantee the entire account archive exists in the frontend.
- UI changes: if card selectors stop matching, the collector reports no visible cards. Update selectors only against the visible UI, never by discovering hidden endpoints.
- Protected/deactivated/suspended account: stop and record the page state; do not attempt alternate access.
- Rate limit / challenge: stop; no automated retry, proxy rotation, or challenge bypass.
- Partial run: each record is appended as soon as extracted, so a browser crash does not discard earlier records.

## Data pipeline

- Run `npm run audit:data` after each collection batch to review duplicates, date coverage, missing core fields, encoding anomalies, media-alt quality, author attribution and visible metric coverage.
- The audit reads local JSONL and prints aggregate diagnostics; it does not upload post content.
- Import accepts JSON arrays or JSONL.
- Allowed competitor is checked against `trackedCompetitor`; legacy records use `authorUsername`.
- Duplicate key is tracked competitor plus post ID.
- Invalid dates and non-HTTP(S) URLs are reported per row.
- Media-only posts may have an empty text field.
- Keep output append-only and back up before any schema migration.
- Rotate large output files by date before production scale.

## Continuous monitoring

- Run `npm run collect:cycle` for one end-to-end update.
- The cycle is sequential; it must not overlap another run using the same Chromium profile.
- The default thread budget is five roots per cycle. New roots are processed before already checked roots; incomplete roots are revisited in least-recently-checked order.
- Windows Task Scheduler launcher: `scripts/run-cycle.ps1`.
- Schedule only while the desktop user is logged in because the collector currently uses headed Chromium.
- Review `data/output/cycle-runs.jsonl` and `data/output/scheduled-monitor.log` after scheduled runs.
- The suggested interval is 60 minutes in config and must be adjusted to the written X authorisation and observed run duration.

## Recovery

1. Stop the running Node process.
2. Close Chromium windows using the project profile.
3. Run `npm run auth:check`.
4. Re-run the collector in headed mode after the session is confirmed.
5. If the profile is corrupt, close Chromium, back up `.local/browser-profile/`, rename it, and run `npm run auth:setup`.
