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

Build the active 365-day materialisation first:

```powershell
npm run build:window
```

In another terminal, with the Python virtual environment activated:

```powershell
python nlp-engine\scripts\analyze_jsonl.py --limit 10
```

The processor automatically chooses `tic` or `aspire_lifestyle` using each competitor's `domainId` in `config/competitors.json`. Use `--domain tic` or `--domain aspire_lifestyle` only to override the mapping for a deliberate test.

The script resumes by skipping competitor/post IDs already present in the output file.

## Files

- Input: `data/output/conversation-365d.jsonl`
- Output: `data/output/enriched-posts.jsonl`

The service listens only on localhost by default. Keep raw collection and enriched output local until retention, privacy and X authorisation terms are reviewed.

## Important limits

- A detected location is only a text mention. It is not automatically the complainant's region.
- Thread replies are included only when the visible conversation card exposes reply context; coverage remains explicitly partial until validated.
- Candidate relations are not guaranteed to have the correct typed endpoints; downstream validation must check them.
- Classification labels require evaluation on manually reviewed TIC and Aspire examples.
- Complaints, strategic gaps, impact estimates and actionables require a separate evidence-grounded reasoning step and multi-post aggregation.
