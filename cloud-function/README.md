# Enrichment Cloud Function

Triggers automatically on `object.finalize` in `gs://sytycai-video-transcripts/`. Reads the raw transcript JSON, calls Claude Sonnet 4.6 to extract per-Housewife drama profiles, and writes two outputs to `gs://sytycai-video-transcripts-enriched/`:

- `{basename}-enriched.json` — full enriched payload
- `csv/{basename}.csv` — one row per Housewife (flat schema for Data Cloud ingestion)

No manual step required — drop a file in the raw bucket and enrichment fires.

## Deploy

```bash
gcloud functions deploy enrich-transcript \
  --gen2 \
  --region=us-east1 \
  --runtime=python312 \
  --source=. \
  --entry-point=on_transcript_finalized \
  --trigger-bucket=sytycai-video-transcripts \
  --memory=512Mi \
  --timeout=540s \
  --ingress-settings=internal-only \
  --set-secrets=ANTHROPIC_API_KEY=anthropic-api-key:latest \
  --service-account=<your-function-sa>@<project>.iam.gserviceaccount.com
```

## Backfill

To generate `csv/` siblings for enriched files that pre-date the CSV output change:

```bash
cd cloud-function
python backfill_csv.py --dry-run   # preview
python backfill_csv.py             # run
```

## Grounding fields (optional)

The ingestion form captures `cast`, `notes`, and `speaker_hints` in the raw JSON — Claude uses these to anchor speaker attribution. `speaker_hints` is not on the form; hand-edit the GCS JSON after a first-pass to correct mis-attributions, then re-upload to re-trigger enrichment.
