# X Competitor Intelligence Engine

A local-first collection and evidence extraction pipeline for TIC and Aspire Lifestyle competitors. X collection is restricted to the exact written permission scope. The normalized source and intelligence contracts are designed so an officially provided API adapter can replace the temporary source when API access is issued on January 15, 2027.

## Active competitors

| Organisation | X account | Domain taxonomy |
|---|---|---|
| Ten Technologies Group (formerly Ten Lifestyle Group) | `tenlifestyle` | `aspire_lifestyle` |
| SGS | `SGS_SA` | `tic` |

Add more organisations in `config/competitors.json` and assign a `domainId`. The engine is designed for TIC businesses, payment networks, banks, card issuers, travel, hospitality, loyalty and concierge providers.

## 1. Install and authenticate

Requires Node.js 20+.

```powershell
git pull origin main
npm install
npx playwright install chromium
npm run auth:check
```

Sign in manually in headed Chromium when prompted. The persistent profile lives in `.local/browser-profile/`; it is git-ignored and never exported into project source.

## 2. Rolling 365-day profile collection

Latest-first incremental runs:

```powershell
npm run collect:ten
npm run collect:sgs
```

One-time backfill of all enabled competitors across the last 365 elapsed days:

```powershell
npm run backfill:year
```

The backfill stops only after multiple consecutive visible screens contain no in-window posts and older-than-cutoff posts are visible. Duplicates do not end a historical scan. A 1,200-scroll safety stop is reported as partial, not complete. Checkpoints are saved every 25 screens per competitor/timeline, so re-running `npm run backfill:year` resumes after the last saved post ID. A checkpoint that cannot be found is left unchanged and reported as partial. Review `data/output/collection-runs.jsonl` and `data/output/backfill-checkpoints.json`.

Current profile collection captures:
- Posts timeline and Replies timeline (posts/replies authored by the competitor account)
- Visible text, timestamp, post URL and engagement counts
- Image/video presence and visible media references
- Hashtags, @mentions, quote/repost references where the UI exposes them
- Basic relationship edges for tags, mentions, quotes and reposts
- Engagement snapshots when visible counts change or the configured interval expires

## 3. Build the active window

```powershell
npm run build:window
```

This creates:
- `data/output/posts-365d.jsonl`: only the latest rolling 365 days
- `data/output/window-manifest.json`: cutoff, counts, top hashtags and competitor breakdown

The original `posts.jsonl` is preserved. Older rows already collected are excluded from the AI input but are not silently deleted. The window builder also derives hashtags and account mentions from legacy source text, so older records do not need to be re-collected just to recover explicit tags.

## 4. Validate public conversation replies

Before starting the full historical backfill, validate the conversation selector against a small set of posts already collected:

```powershell
npm run build:window
npm run threads:queue
npm run collect:threads -- --limit 3
npm run build:conversation
```

Inspect `data/output/thread-replies.jsonl` and `data/output/thread-progress.jsonl`. Confirm that reply authors, root post IDs and visible reply text match what you see in the browser. Threads with unclassified cards or safety limits must remain partial.

After the three-thread test is correct, backfill the rolling year:

```powershell
npm run backfill:year
npm run build:window
npm run threads:queue
```

Then resume public conversation collection in bounded batches or use the recurring cycle.

## 5. Ongoing public conversation collection

The queue contains original competitor posts within the current 365-day window. Continue collecting in bounded batches:

```powershell
npm run collect:threads -- --limit 10
npm run build:conversation
```

Repeat bounded batches after inspecting progress, or use the recurring cycle:

```powershell
npm run collect:cycle
```

A cycle refreshes the latest competitor timelines, rebuilds the rolling 365-day file, refreshes the conversation queue, scans up to five fairly scheduled thread roots, merges the conversation dataset and audits it. The five-root limit is configurable as `collection.monitorThreadRootsPerCycle`.

The conversation collector captures reply cards that the visible interface identifies as replies and links them to the root post. It records partial/visible-end states and unclassified cards. It can also discover an earlier external participant post when that author appears again in a later captured reply under the selected anchor; these ancestor edges are explicitly unverified until inspected. **A visible end is not proof that X exposed every reply**, so never report complete public-reply coverage without a separate validation step. The queue can be resumed; previously completed roots are revisited after the configured refresh interval.

Conversation outputs:
- `thread-queue-365d.jsonl`
- `thread-replies.jsonl`
- `thread-progress.jsonl`
- `thread-ancestors.jsonl` (earlier participant posts retained as unverified ancestor candidates)
- `thread-runs.jsonl`
- `conversation-365d.jsonl`
- `conversation-manifest.json`
- `engagement-snapshots.jsonl` — timestamped visible engagement observations
- `backfill-checkpoints.json` — per-account/timeline resume positions

## 6. Continuous Windows monitoring

The local cycle runner is `scripts/run-cycle.ps1`. To schedule it, open Windows Task Scheduler and create a task with:

1. Trigger: **At log on** for your Windows user, repeat every 60 minutes.
2. Action: start `powershell.exe` with arguments `-NoProfile -ExecutionPolicy Bypass -File "C:\Users\Dell\Desktop\X\X_scrap\scripts\run-cycle.ps1"` (adjust the repository path if needed).
3. Security: choose **Run only when the user is logged on**. The current collector uses headed Chromium and the existing local browser profile.
4. Settings: do not start a second instance when the previous cycle is still running.

Keep the PC awake and the user session active during collection. The log is written to `data/output/scheduled-monitor.log`. The suggested 60-minute interval is configurable; the actual interval should follow the written X authorisation.

## 7. Audit data

```powershell
npm run audit:data
```

The audit reports data integrity, rolling-window eligibility, duplicates, tag coverage, media quality, missing metrics and author attribution. To audit the merged conversations directly:

```powershell
npm run audit:data -- data/output/conversation-365d.jsonl
```

The recurring cycle audits the merged conversation file.

## 8. Local GLiNER2.5 extraction

The first NLP layer uses the multilingual `fastino/gliner2.5-multi-v1` checkpoint. It extracts entity spans, topic/signal labels, complaint categories, service categories, impact themes and candidate relations. See [nlp-engine/README.md](nlp-engine/README.md).

PowerShell setup from the repository root:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r nlp-engine\requirements.txt
python -m uvicorn app.main:app --app-dir nlp-engine --host 127.0.0.1 --port 8010
```

In a second terminal, process a small sample:

```powershell
python nlp-engine\scripts\analyze_jsonl.py --limit 10
```

The script automatically selects the TIC or Aspire taxonomy using each competitor's `domainId`. Remove `--limit 10` to process all available conversation records. Output: `data/output/enriched-posts.jsonl`.

Build the typed entity and relationship graph:

```powershell
npm run graph:build
```

It writes `data/output/entity-graph.json` with stable entity IDs, typed directed edges, evidence IDs and URLs, and validation status. Explicit social edges (hashtags, mentions, quotes, reposts, thread roots and parent replies) are combined with GLiNER relation candidates. Untyped or incompatible model relations remain unvalidated.

Aggregate complaint and event patterns into evidence-linked clusters:

```powershell
python nlp-engine\scripts\aggregate_signals.py
```

Outputs:
- `data/output/signal-clusters.json`: complaint/service clusters, event clusters, monthly counts, distinct author counts and supporting evidence.
- `data/output/preliminary-competitor-brief.json`: preliminary signal brief and candidate investigation actions.

These are candidate signals, not proven gaps. A model-extracted geographic mention is not automatically a complainant's region.

### Generate final evidence-backed briefs

The final reasoning model is optional and provider-neutral. Configure an OpenAI-compatible endpoint in your PowerShell session (a local endpoint or a hosted provider you approve):

```powershell
$env:REASONING_BASE_URL = "http://127.0.0.1:11434/v1"
$env:REASONING_MODEL = "YOUR_INSTRUCT_MODEL"
# Set REASONING_API_KEY only when your endpoint requires it.
python nlp-engine\scripts\generate_brief.py
```

The script reads domain taxonomies, coverage manifests and a bounded entity-graph summary; it sends aggregated clusters plus selected evidence excerpts, and writes:
- `data/output/competitor-brief-tic.json`
- `data/output/competitor-brief-aspire_lifestyle.json`

It computes collection coverage and date boundaries locally, validates each model response against `schemas/intelligence-brief.schema.json`, and saves invalid responses with validation errors rather than treating them as usable briefs. For hosted providers, review your data-handling requirements before sending source quotes outside your machine.

## 9. Strategic reasoning and JSON outputs

GLiNER2.5 is the structured extraction layer, not the complete reasoning engine. A separate evidence-grounded LLM stage will synthesize recurring complaints, root-cause hypotheses, regions, business impact, competitor gaps, launches and actionables. Each claim must cite source post/reply IDs and exact evidence; hypotheses must be labelled as hypotheses.

Schemas:
- `schemas/intelligence-event.schema.json`: individual evidence-backed event
- `schemas/intelligence-brief.schema.json`: rolling competitor intelligence brief
- `config/intelligence/ontology.json`: shared entity and relation ontology
- `config/intelligence/tic.json`: TIC taxonomy
- `config/intelligence/aspire.json`: Aspire taxonomy
- `docs/INTELLIGENCE_ARCHITECTURE.md`: full data and analysis architecture
- `nlp-engine/prompts/strategic-analyst-system.md`: evidence-grounded reasoning instructions for the final AI analyst stage

## Security, privacy and coverage

- Keep collection and analysis outputs local; `data/output/` is git-ignored.
- Follow X's written authorisation exactly, including interface, target accounts, frequency and retention.
- Stop on platform challenges or limits. Do not bypass access controls.
- Do not infer a complainant's region from name, handle, language or profile appearance.
- Distinguish the company's own claims from customer reports and independently verified facts.
- Do not treat one complaint as proof of a competitor gap.
- Store unknown region, parent relationships and impact as null/unknown when the source does not establish them.

## API transition

The planned API transition date is recorded as January 15, 2027. The normalized post and intelligence schemas are source-independent so the supported API adapter can replace the browser source without changing the downstream NLP and graph pipeline.
