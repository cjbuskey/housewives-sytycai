# Enrichment Cloud Function

Triggered by `object.finalize` on `gs://sytycai-video-transcripts/`. Reads the raw transcript JSON, calls Claude Sonnet 4.6 to extract per-Housewife drama profiles, and writes the enriched JSON to `gs://sytycai-video-transcripts-enriched/`.

## Prerequisites

1. A GCP project with Cloud Functions, Cloud Storage, and Secret Manager APIs enabled
2. Both buckets created: `sytycai-video-transcripts` and `sytycai-video-transcripts-enriched`
3. An Anthropic API key stored in Secret Manager as `anthropic-api-key`
4. A service account with:
   - `roles/storage.objectViewer` on the raw bucket
   - `roles/storage.objectCreator` on the enriched bucket
   - `roles/secretmanager.secretAccessor` on the `anthropic-api-key` secret

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

> `--timeout=540s` (9 min) is the max for 2nd-gen functions and gives Claude room for long reunion transcripts.

## Test Locally

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Set env vars
export ANTHROPIC_API_KEY=sk-ant-...
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

# 3. Run the functions framework locally
functions-framework --target=on_transcript_finalized --signature-type=cloudevent

# 4. In another terminal, send a mock GCS event
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/cloudevents+json" \
  -d '{
    "specversion": "1.0",
    "type": "google.cloud.storage.object.v1.finalized",
    "source": "//storage.googleapis.com/projects/_/buckets/sytycai-video-transcripts",
    "subject": "objects/test-file.json",
    "id": "test-event-1",
    "time": "2026-04-21T00:00:00Z",
    "data": {
      "bucket": "sytycai-video-transcripts",
      "name": "your-existing-transcript.json"
    }
  }'
```

## Environment Variables

| Variable              | Required | Default                              | Purpose                                                                 |
| --------------------- | -------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`   | ✅       | —                                    | Claude API auth (from Secret Manager in prod)                           |
| `GCS_ENRICHED_BUCKET` | ❌       | `sytycai-video-transcripts-enriched` | Where to write enriched files                                           |
| `GCS_RAW_BUCKET`      | ❌       | `sytycai-video-transcripts`          | Trigger bucket (reference only — the trigger itself is wired at deploy) |

## Input JSON: optional grounding fields

The ingestion app captures three optional grounding fields on the form: **Cast**, **Additional Context**, and (from the core metadata) show/season/episode. Those land in the JSON as:

```json
{
  "show": "Real Housewives of Salt Lake City",
  "season": 4,
  "episode_title": "Reunion Part 1",
  "transcript": "...",

  "cast": [
    "Heather Gay",
    "Lisa Barlow",
    "Meredith Marks",
    "Whitney Rose",
    "Angie Katsanevas",
    "Monica Garcia",
    "Mary Cosby"
  ],

  "notes": "Monica Garcia is new this season. The lawsuit storyline dominates part 2.",

  "speaker_hints": [
    "The host asking follow-up questions is Andy Cohen, not a Housewife.",
    "Any line about 'my lawsuit' or 'my husband's investigation' is Monica.",
    "When someone is called a liar on the stairs, that moment is Heather talking about Monica."
  ]
}
```

- `cast` — the Housewives actually appearing in this reunion. Anchors attribution when Claude's training data is incomplete or when "Friends of" appear. Entered on the ingestion form as a comma-separated list.
- `notes` — free-form producer context about the season or episode. Entered on the ingestion form as a text area.
- `speaker_hints` — **not exposed on the form.** Hand-edit this into the GCS JSON after seeing what Claude mis-attributes on a first pass. Free-form plain-English nudges; no schema.

All three are optional and additive.

## Output Schema

Each enriched file contains:

```json
{
  "source": {
    "raw_bucket": "...",
    "raw_file": "...",
    "source_url": "...",
    "show": "...",
    "season": 4,
    "episode_title": "..."
  },
  "extracted_at": "2026-04-20T...",
  "enriched_at": "2026-04-20T...",
  "model": "claude-sonnet-4-6",
  "franchise": "Salt Lake City",
  "profiles": [
    {
      "housewife_name": "Meredith Marks",
      "drama_score": 72,
      "feuds": ["Lisa Barlow: ...", "Heather Gay: ..."],
      "key_moments": ["..."],
      "talking_points": ["...", "...", "..."],
      "confessional_draft": "..."
    }
  ],
  "usage": { "input_tokens": 28141, "output_tokens": 1892, "cache_read_input_tokens": 423 }
}
```
