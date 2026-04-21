# Real Housewives Reunion Ready — AI Drama Coach

> _"Brief me on Erika before tonight."_

Multi-agent pipeline that ingests Real Housewives reunion transcripts, maps drama arcs, and powers a Bravo-producer-voiced Agentforce chatbot. Built for the **So You Think You Can AI** contest.

## Stack

| Layer      | Tech                              |
| ---------- | --------------------------------- |
| Ingestion  | Local Node.js app (YouTube → GCS) |
| Storage    | GCP Cloud Storage (2 buckets)     |
| Enrichment | GCP Cloud Function + Claude       |
| Voice      | ElevenLabs                        |
| Data       | Salesforce Data Cloud             |
| Agent      | Salesforce Agentforce             |

## Run Locally

**Prerequisites:** Node.js ≥ 20, a GCP project with a Cloud Storage bucket named `sytycai-video-transcripts`, and a service account with `storage.objects.create` on that bucket.

```bash
# 1. Install dependencies
npm install

# 2. Set up your GCP service account key
cp service-account.example.json service-account.json
# then open service-account.json and paste the real JSON from
# GCP Console → IAM → Service Accounts → Keys → Add Key → Create New (JSON).
# service-account.json is gitignored — the example file is the only one tracked.

# 3. Configure environment
cp .env.example .env
# edit .env and set:
#   GOOGLE_APPLICATION_CREDENTIALS=<absolute path to service-account.json>
#   GOOGLE_CLOUD_PROJECT_ID=<your-gcp-project-id>

# 4. Start the server (dotenv loads .env automatically)
npm start
```

Open <http://localhost:3000> and paste a YouTube URL. Transcripts land in `gs://sytycai-video-transcripts/`, which triggers the Cloud Function enrichment pipeline.

**Scripts:**

```bash
npm run dev           # auto-restart on file changes
npm run lint          # ESLint
npm run format        # Prettier --write
```

## Project Steps

See [plans/project-plan.md](plans/project-plan.md) for the full plan.

1. Local ingestion app — accepts YouTube URLs, stores transcripts in GCP
2. Cloud Function — auto-triggers on upload, enriches with Claude
3. Data Cloud — ingests enriched data, harmonizes with Contact records
4. Agentforce — Reunion Prep Coach with Bravo producer persona
