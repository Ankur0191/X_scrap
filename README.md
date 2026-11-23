# X Competitor Intelligence Engine

A local-first intelligence pipeline for TIC and Aspire Lifestyle competitors. X collection is limited to the written permission scope and currently uses the visible frontend collector; the platform API adapter is intended to replace it when the promised access is issued on January 15, 2027.

## Current competitor targets

| Organisation | X handle | Intelligence domain |
|---|---|---|
| Ten Technologies Group (formerly Ten Lifestyle Group) | `tenlifestyle` | `aspire_lifestyle` |
| SGS | `SGS_SA` | `tic` |

Edit `config/competitors.json` to add organisations. The `domainId` field selects the appropriate NLP taxonomy.

## 1. Install and authenticate

Requires Node.js 20+.

```powershell
npm install
npx playwright install chromium
npm run auth:check
```

Use the persistent headed browser profile and sign in manually when prompted. The local profile is stored in `.local/browser-profile/`, excluded from Git and never exported as a source file.

## 2. Collect the rolling one-year window

Latest-first incremental scan:

```powershell
npm run collect:ten
npm run collect:sgs
```

One-time 365-day profile backfill for all enabled competitors:

```powershell
npm run backfill:year
```

The backfill uses the rolling cutoff and requires multiple consecutive screens containing no in-window posts before it marks the timeline boundary as reached. It does not stop just because visible cards are duplicates. The 1,200-scroll safety bound is a fail-safe, not a claim of completeness. Check each timeline's `completion` field in `data/output/collection-runs.jsonl`.

Current profile collection covers:
- Posts timeline
- Replies timeline (posts/replies authored by the competitor account)
- Visible text, dates, status URLs and action counts
- Image/video presence and image alt/display URL
- Explicit hashtags and @mentions with basic relationship edges

**It does not yet guarantee every third-party reply under every competitor post.** Those require a separate conversation/thread crawler and independent coverage status. Do not label public thread replies complete until that layer is implemented and validated.

## 3. Build the active rolling dataset

The original `posts.jsonl` is preserved as the local collection log. Create a clean AI input containing only the current 365-day window:

```powershell
npm run build:window
```

Outputs:
- `data/output/posts-365d.jsonl` — in-window records sorted by publication date
- `data/output/window-manifest.json` — cutoff, counts, competitor split, post types and top hashtags

The window builder also derives hashtags and account mentions from the original source text for legacy records collected before those fields were added. It does not rewrite the original collection file.

## 4. Audit collection quality

```powershell
npm run audit:data
```

The report includes duplicates, invalid fields, rolling-window eligibility, tag coverage, media metadata and metric coverage.

## 5. Run local GLiNER2.5 extraction

See [nlp-engine/README.md](nlp-engine/README.md).

PowerShell setup:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r nlp-engine\requirements.txt
python -m uvicorn app.main:app --app-dir nlp-engine --host 127.0.0.1 --port 8010
```

In a second terminal:

```powershell
npm run build:window
python nlp-engine\scripts\analyze_jsonl.py --limit 10
```

The processor maps Ten to the Aspire taxonomy and SGS to the TIC taxonomy automatically. Remove `--limit 10` to process the entire active file. Results are written to `data/output/enriched-posts.jsonl`.

## Intelligence architecture

- [Architecture and coverage design](docs/INTELLIGENCE_ARCHITECTURE.md)
- [Common ontology](config/intelligence/ontology.json)
- [TIC taxonomy](config/intelligence/tic.json)
- [Aspire taxonomy](config/intelligence/aspire.json)
- [Evidence-backed event schema](schemas/intelligence-event.schema.json)
- [365-day intelligence brief schema](schemas/intelligence-brief.schema.json)

GLiNER2.5 is the extraction layer, not the final strategic reasoning model. Complaints, competitor gaps, impact and actionables need a separate evidence-grounded LLM stage and multi-post aggregation. Every conclusion should retain the post/reply IDs and exact evidence.

## Data and security

- Raw collection, browser profile and outputs stay local and are git-ignored.
- Keep X's written authorization and follow its exact account, interface, frequency, retention and automation scope.
- Stop on platform challenges or limits; do not bypass them.
- Do not infer a complainant's location from their handle, name or language.
- Do not treat one complaint as proof of a competitor gap.
- Keep customer claims, competitor claims, verified facts and AI hypotheses separate.

## API transition

The config records January 15, 2027 as the planned API transition. The normalized post and intelligence schemas are designed so an officially provided API adapter can replace the browser source without changing the downstream NLP and analytics pipeline.
