# Local GLiNER2.5 extraction service

This service extracts named entities, domain-specific signal labels, complaint categories, service categories, impact themes and candidate relations. It does **not** produce strategic recommendations or assert a competitor gap.

## Recommended first model

- Model: `fastino/gliner2.5-multi-v1`
- Architecture: GLiNER2.5 boundary extractor
- Parameters: 287M
- Purpose: multilingual extraction and classification for globally distributed TIC and Aspire sources.

The official model card recommends `AutoExtractor` for GLiNER2.5. The model supports entity spans, multi-label classification and relation extraction. See https://huggingface.co/fastino/gliner2.5-multi-v1.

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

To select a different supported model checkpoint:

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

## Process a small sample

Build the rolling-window file first:

```powershell
npm run build:window
```

In another terminal, with the Python virtual environment activated:

```powershell
python nlp-engine\scripts\analyze_jsonl.py --domain tic --limit 10
```

Use `--domain aspire_lifestyle` for Aspire's domain taxonomy. The script resumes by skipping post IDs already present in the output file.

## Files

- Input: `data/output/posts-365d.jsonl`
- Output: `data/output/enriched-posts.jsonl`

The service listens only on localhost by default. Keep raw collection and enriched output local until the retention, privacy and X-authorisation terms are reviewed.

## Important limits

- A detected location is only a text mention. It is not automatically the complainant's region.
- Candidate relations are not guaranteed to have the correct typed endpoints; downstream validation must check them.
- Classification labels require evaluation on manually reviewed TIC and Aspire examples.
- Complaints, strategic gaps, impact estimates and actionables require a separate evidence-grounded reasoning step and multi-post aggregation.
