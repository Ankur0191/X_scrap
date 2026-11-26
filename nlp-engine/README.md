# Local GLiNER2.5 extraction service

This service extracts named entities, domain-specific signal labels, complaint categories, service categories, impact themes and candidate relations. It does **not** produce strategic recommendations or assert a competitor gap.

## Recommended first model

- Model: `fastino/gliner2.5-multi-v1`
- Architecture: GLiNER2.5 boundary extractor
- Parameters: 287M
- Purpose: multilingual extraction and classification for globally distributed TIC and Aspire sources.

The official model card recommends `AutoExtractor` for GLiNER2.5. The model supports entity spans, multi-label classification and relation extraction locally. See https://huggingface.co/fastino/gliner2.5-multi-v1.

## Windows setup

From the repository root in PowerShell:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r nlp-engine\requirements.txt
```

The first model load downloads weights from Hugging Face. It can run on CPU; if CUDA PyTorch is installed and available, the service automatically selects CUDA. To force CPU:

```powershell
$env:GLINER_DEVICE = "cpu"
```

To select another supported checkpoint:

```powershell
$env:GLINER_MODEL_ID = "fastino/gliner2.5-base-v1"
```

## Start the service

From the repository root:

```powershell
python -m uvicorn app.main:app --app-dir nlp-engine --host 127.0.0.1 --port 8010
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8010/health
```

## Process a sample

Build the active 365-day collection and merged conversation dataset first:

```powershell
npm run build:window
npm run threads:queue
npm run collect:threads -- --limit 3
npm run build:conversation
```

In another terminal, with the Python virtual environment activated:

```powershell
python nlp-engine\scripts\analyze_jsonl.py --limit 10
```

The processor automatically chooses `tic` or `aspire_lifestyle` using each competitor's `domainId` in `config/competitors.json`. Use `--domain tic` or `--domain aspire_lifestyle` only to override the mapping for a deliberate test.

The script resumes by skipping competitor/post IDs already present in the output file.

Build the typed entity and relationship graph:

```powershell
npm run graph:build
```

The graph includes social edges for hashtags, mentions, quotes, reposts, replies and thread roots, plus GLiNER relations with ontology validation status. Unvalidated relation candidates remain explicitly marked.

## Aggregate complaint and event patterns

After enrichment finishes:

```powershell
python nlp-engine\scripts\aggregate_signals.py
```

It creates:
- `data/output/signal-clusters.json`
- `data/output/preliminary-competitor-brief.json`

Clusters include complaint/service categories, public-author counts, month-by-month volume, geographic text mentions and source evidence. Geographic mentions are not treated as complainant regions. Candidate gaps remain hypotheses and include investigation steps.

The final reasoning instructions are in `nlp-engine/prompts/strategic-analyst-system.md`. They require the downstream model to cite post/reply IDs and exact source evidence, distinguish official claims from customer reports, and separate observed impact from hypotheses.

## Generate final domain briefs

The final reasoning call is optional and requires an OpenAI-compatible Chat Completions endpoint:

```powershell
$env:REASONING_BASE_URL = "http://127.0.0.1:11434/v1"
$env:REASONING_MODEL = "YOUR_INSTRUCT_MODEL"
# For an authenticated endpoint:
# $env:REASONING_API_KEY = "your-key"
python nlp-engine\scripts\generate_brief.py
```

The script generates one brief per enabled domain, using aggregated clusters and a limited number of supporting evidence excerpts. It also includes visible engagement snapshots and observed changes when available. It computes coverage itself and validates the response against the JSON Schema. It does not claim complete public-thread coverage from visible-end signals. Use a local endpoint to keep source excerpts on your machine; a hosted model receives only the selected evidence excerpts and aggregate data.

Outputs:
- `data/output/competitor-brief-tic.json`
- `data/output/competitor-brief-aspire_lifestyle.json`

## Files

- Input: `data/output/conversation-365d.jsonl`
- Output: `data/output/enriched-posts.jsonl`

The service listens only on localhost by default. Keep raw collection and enriched output local until retention, privacy and X authorisation terms are reviewed.

## TIC six-month pipeline

Use explicit TIC six-month paths so the analysis does not read or overwrite the default 365-day and Aspire outputs. After all 261 source records have been enriched:

```powershell
python nlp-engine\scripts\build_entity_graph.py --input data/output/enriched-posts-tic-184d.jsonl --output data/output/entity-graph-tic-184d.json

python nlp-engine\scripts\aggregate_signals.py --input data/output/enriched-posts-tic-184d.jsonl --output data/output/signal-clusters-tic-184d.json --brief data/output/preliminary-competitor-brief-tic-184d.json
```

Complaint clusters are source-aware by default. A complaint candidate must be an external account's thread-linked record, have negative or mixed sentiment, and have a specific complaint label. Competitor-published announcements remain available for strategic event analysis, but are not treated as customer complaints. External accounts are still not automatically customers; inspect every candidate against its original thread.

After configuring an approved OpenAI-compatible reasoning endpoint, generate only the TIC brief with the exact six-month manifests and graph:

```powershell
$env:REASONING_BASE_URL = "http://127.0.0.1:11434/v1"
$env:REASONING_MODEL = "YOUR_INSTRUCT_MODEL"

python nlp-engine\scripts\generate_brief.py --domain tic --clusters data/output/signal-clusters-tic-184d.json --conversation data/output/conversations-tic-184d.jsonl --window-manifest data/output/window-manifest-tic-184d.json --conversation-manifest data/output/conversation-manifest-tic-184d.json --graph data/output/entity-graph-tic-184d.json --thread-progress data/output/thread-progress-tic-184d.jsonl --output-dir data/output/tic-184d-brief
```

The generated brief is written to `data/output/tic-184d-brief/competitor-brief-tic.json`. Its window is taken from `window-manifest-tic-184d.json`; the schema accepts the declared duration rather than forcing 365 days.

## Important limits

- A detected location is only a text mention. It is not automatically the complainant's region.
- Thread replies are included only when the visible conversation card exposes reply context; coverage remains explicitly partial until validated.
- Candidate relations are not guaranteed to have the correct typed endpoints; downstream validation must check them.
- Classification labels require evaluation on manually reviewed TIC and Aspire examples.
- Complaints, strategic gaps, impact estimates and actionables require a separate evidence-grounded reasoning step and multi-post aggregation.
