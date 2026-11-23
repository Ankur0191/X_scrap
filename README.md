# X Competitor Intelligence Collector

Local-first, headed Chromium collector for the visible X frontend, restricted to the competitor accounts and collection scope covered by your written X authorization.

## Authorization boundary

Use this collector only within the exact scope of X's written permission. X's Terms include an express-written-permission exception for scraping, while its separate automation rules describe restrictions on scripting the X website. Confirm that the approval explicitly covers this temporary visible-frontend browser automation. This project does not access private endpoints, call undocumented APIs, inspect internal application state, intercept network requests, defeat CAPTCHA, evade rate limits, rotate proxies, or use stealth/fingerprint spoofing.

The collector reads rendered timeline cards through Playwright locators and navigates using normal page URLs and scrolling. It is not a general-purpose X crawler.

## Current targets

- `tenlifestyle` — Ten Technologies Group (formerly Ten Lifestyle Group)
- `SGS_SA` — SGS

Edit `config/competitors.json` to enable/disable accounts and tune conservative collection limits.

## Setup

Requires Node.js 20+.

```bash
npm install
npx playwright install chromium
npm run auth:setup
npm run auth:check
npm test
```

The persistent Chromium profile lives in `.local/browser-profile/`. Sign in manually in the visible browser. Passwords, cookies and verification codes are never written to project files. The profile directory is excluded from Git; do not copy it to shared runners or commit it.

## Collect

Latest-first scan (headed Chromium by default):

```bash
npm run collect
```

Scan one competitor:

```bash
node src/collector/run.js --account tenlifestyle
node src/collector/run.js --account SGS_SA
```

Historical backfill through the available timeline, subject to the configured 250-scroll safety bound:

```bash
npm run collect:all
```

Output:
- `data/output/posts.jsonl` — append-only normalized visible post records.
- `data/output/collection-runs.jsonl` — run summaries and stop reasons.

The collector scans the Posts and Replies tabs. It deduplicates by tracked competitor plus post ID, so a post present in both views is stored once. Metrics and media metadata are captured only when visible in the rendered card. A metric not shown by X remains null.

## Authentication lifecycle

`npm run auth:check` opens the persistent browser and checks the actual signed-in UI state. Cookie expiry metadata alone is not reliable proof of a valid session. If signed out, complete login manually. MFA, CAPTCHA and account security checks must be completed by the account owner; the collector stops rather than bypassing them.

Never run two jobs against the same browser profile at once.

## Headless mode

Headed mode is the default. Headless mode is disabled in configuration until the written approval is confirmed to cover it. Do not enable it merely to avoid platform challenges or account safeguards.

## January 15, 2027 API transition

The intended transition date is recorded in config. When X provides the API credentials and applicable access terms, replace the UI collector with the officially supported API adapter. Keep the common normalized schema so historical data and the Rivalmap pipeline remain compatible.

## Data handling

Store collected data locally, restrict access to the output folder, and apply retention/deletion requirements from the written authorization. Do not enrich posts with private personal data. Preserve source URLs, timestamps, tracked competitor and collection provenance.
