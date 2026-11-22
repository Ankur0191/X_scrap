# X Competitor Intelligence Collector

A local-first project scaffold for ingesting **authorized** X data into a normalized competitor-intelligence dataset.

> Compliance boundary: X's Terms prohibit scraping without prior written permission, and X's Automation Rules prohibit scripting the X website. This project therefore does not automate X website collection, bypass access controls, or evade rate limits. Use an authorized X API integration, an X-provided export, or a source for which you have explicit permission.

## What is included

- Persistent local Chromium profile for a user-controlled, manual browser session (diagnostics only).
- Authentication preflight that reports whether a saved local profile exists and whether an X page appears signed in. It does not export, copy, or reuse X credentials.
- JSON configuration for selective competitor accounts.
- A normalized JSONL ingestion interface for authorized exports / permitted sources.
- Deduplication, source attribution, structured logs, and tests.

## Quick start

Requires Node.js 20+.

```bash
npm install
npx playwright install chromium
npm run auth:check
npm run auth:setup
npm run ingest:sample
npm test
```

### Local browser session

`npm run auth:setup` opens Chromium in headed mode at X. Sign in manually if you need to inspect your own account; close the browser when finished. The browser profile is saved under `.local/browser-profile/` and is git-ignored. This profile is not a scraping credential store and the project does not extract cookies or storage state from it.

`npm run auth:check` checks whether the profile directory exists and opens a read-only headed diagnostic session. A visible sign-in prompt may be shown if the page is not signed in. X can change its UI at any time, so the detector is intentionally conservative and must not be used as an authorization bypass.

## Competitors

Edit `config/competitors.json`. Store canonical usernames without the @ symbol and set `enabled` to true only for accounts you are authorized to monitor.

## Authorized ingestion

Place a normalized JSON array or JSONL file in `data/inbox/` and run:

```bash
npm run ingest -- --input data/inbox/posts.jsonl
```

Required fields: `id`, `authorUsername`, `text`, `createdAt`, `url`. Optional fields include `metrics`, `language`, `media`, and `source`. Records are filtered to enabled competitor usernames and deduplicated by post ID. Output is appended to `data/output/posts.jsonl`.

See `docs/DATA_SCHEMA.md` and `docs/OPERATIONS.md`.

## Security

- Never commit browser profiles, cookies, tokens, exports, or collected data.
- Do not upload credentials to GitHub Actions, shared runners, or issue trackers.
- Do not attempt to defeat CAPTCHA, MFA, rate limits, login checks, or platform controls.
- Use least-privilege credentials only for supported and authorized integrations.
