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

The backfill stops only after multiple consecutive visible screens contain no in-window posts and older-than-cutoff posts are visible. Duplicates do not end a historical scan. A 1,200-scroll safety stop is reported as incomplete, not complete. Review `data/output/collection-runs.jsonl`.

Current profile collection captures:
- Posts timeline and Replies timeline (posts/replies authored by the competitor account)
- Visible text, timestamp, post URL and engagement counts
- Image/video presence and visible media references
- Hashtags, @mentions, quote/repost references where the UI exposes them
- Basic relationship edges for tags, mentions, quotes and reposts

## 3. Build the active window

```powershell
npm run build:window
```

This creates:
- `data/output/posts-365d.jsonl`: only the latest rolling 365 days
- `data/output/window-manifest.json`: cutoff, counts, top hashtags and competitor breakdown

The original `posts.jsonl` is preserved. Older rows already collected are excluded from the AI input but are not silently deleted. The window builder also derives hashtags and account mentions from legacy source text, so older records do not need to be re-collected just to recover explicit tags.

## 4. Collect public conversation replies

Build a queue of original in-window competitor posts:

```powershell
npm run threads:queue
```

Start with three threads for selector validation:

```powershell
npm run collect:threads -- --limit 3
```

After inspecting the resulting replies and progress report, continue the queue:

```powershell
npm run collect:threads
npm run build:conversation
```

For ongoing monitoring, run one complete cycle:

```powershell
npm run collect:cycle
```

A cycle refreshes the latest competitor timelines, rebuilds the rolling 365-day file, refreshes the conversation queue, scans up to five fairly scheduled thread roots, merges the conversation dataset and runs the audit. The five-root limit is configurable as `collection.monitorThreadRootsPerCycle`.

The conversation collector captures reply cards that the visible interface identifies as replies and links them to the root post. It records partial/visible-end states and unclassified cards. **A visible end is not proof that X exposed every reply**, so never report complete public-reply coverage without a separate validation step. The queue can be resumed; previously completed roots are revisited after the configured refresh interval.

Conversation outputs:
- `thread-queue-365d.jsonl`
- `thread-replies.jsonl`
- `thread-progress.jsonl`
- `thread-runs.jsonl`
- `conversation-365d.jsonl`
- `conversation-manifest.json`

## 5. Continuous Windows monitoring

The local cycle runner is `scripts/run-cycle.ps1`. To schedule it, open Windows Task Scheduler and create a task with:

1. Trigger: **At log on** for your Windows user, repeat every 60 minutes.
2. Action: start `powershell.exe` with arguments `-NoProfile -ExecutionPolicy Bypass -File "C:\Users\Dell\Desktop\X\X_scrap\scripts\run-cycle.ps1"` (adjust the repository path if needed).
3. Security: choose **Run only when the user is logged on**. The current collector uses headed Chromium and the existing local browser profile.
4. Settings: do not start a second instance when the previous cycle is still running.

Keep the PC awake and the user session active during collection. The log is written to `data/output/scheduled-monitor.log`. The suggested 60-minute interval is configurable; the actual interval should follow the written X authorisation.

## 6. Audit data

```powershell
npm run audit:data
```

The audit reports data integrity, rolling-window eligibility, duplicates, tag coverage, media quality, missing metrics and author attribution.

## 7. Local GLiNER2.5 extraction

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

Aggregate complaint and event patterns into evidence-linked clusters:

```powershell
python nlp-engine\scripts\aggregate_signals.py
```

Outputs:
- `data/output/signal-clusters.json`: complaint/service clusters, event clusters, monthly counts, distinct author counts and supporting evidence.
- `data/output/preliminary-competitor-brief.json`: preliminary signal brief and candidate investigation actions.

These are candidate signals, not proven gaps. A model-extracted geographic mention is not automatically a complainant's region.

## 8. Strategic reasoning and JSON outputs

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
