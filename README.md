# Real Housewives Reunion Ready — AI Drama Coach

> _"Brief me on Erika before tonight."_

Multi-agent pipeline that ingests Real Housewives reunion transcripts, maps drama arcs, and powers a Bravo-producer-voiced Agentforce chatbot. Built for the **So You Think You Can AI** contest.

## Stack

| Layer      | Tech                              |
| ---------- | --------------------------------- |
| Ingestion  | Local Node.js app (YouTube → GCS) |
| Enrichment | GCP Cloud Function + Claude       |
| Voice      | ElevenLabs (Carolina / Min Diesel)|
| Data       | Salesforce Data Cloud             |
| Agent      | Salesforce Agentforce             |


<img width="1200" alt="Architecture" src="https://github.com/user-attachments/assets/f7c4a85c-8373-4b9a-9e33-3be8c220c1e5" />

## Run Locally

**Prerequisites:** Node.js ≥ 20, GCP project, service account with `storage.objects.create` on `sytycai-video-transcripts`.

```bash
npm install
cp service-account.example.json service-account.json  # paste real GCP key JSON
cp .env.example .env                                   # fill in credentials
npm start
```

Open <http://localhost:3000>.

### Form fields

| Field              | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| YouTube URL        | Video to transcribe                                                  |
| Franchise / Season | Metadata stored with transcript                                      |
| Cast               | Comma-separated names — anchors Claude's speaker attribution         |
| Additional Context | Producer notes (new cast, key storylines) passed to Claude as grounding |

### Speaker hints (advanced)

Hand-edit the raw JSON in GCS to add `speaker_hints` strings, then re-upload to re-trigger enrichment. See [cloud-function/README.md](cloud-function/README.md) for details.

## Playback Room

<http://localhost:3000/playback> — pick a cast member, read their AI confessional, hit **PLAY**.

Voices: Carolina (female, default) · Min Diesel (male). Set `ELEVENLABS_API_KEY` + voice IDs in `.env`. Audio is cached server- and client-side so repeat plays are instant.

## Coach Room (Headless Agentforce)

<http://localhost:3000/coach> — Bravo-branded chat UI wired directly to the Agentforce agent. No Salesforce Lightning shell needed at demo time.

Uses **JWT Bearer** OAuth (required for `AgentforceEmployeeAgent` type). One-time setup:

```bash
openssl genrsa -out server.key 2048
openssl req -new -x509 -key server.key -out server.crt -days 365
```

Upload `server.crt` to a Connected App. Required OAuth scopes: `einstein_genie_api` (or `einstein_gpt_api` depending on your org), `api`, `refresh_token`. Then set in `.env`:

```
SF_INSTANCE_URL=https://yourorg.my.salesforce.com
SF_CLIENT_ID=<consumer key>
SF_AGENT_ID=<18-char agent id>
SF_DEFAULT_USERNAME=<salesforce username>
SF_ORG_ID=<18-char org id — Setup → Company Information>
SF_PRIVATE_KEY_PATH=server.key
```

If any `SF_*` var is missing, `/coach` shows a lock screen — the Salesforce-native chat remains the fallback.

## Data Cloud CSV Pipeline

The Cloud Function writes both a JSON and a flat CSV for every enriched transcript. The CSV (`csv/<filename>.csv`, one row per cast member) is what Data Cloud ingests — it's easier to map than nested JSON.

To backfill CSVs for any enriched files that pre-date this change:

```bash
cd cloud-function
python backfill_csv.py --dry-run   # preview first
python backfill_csv.py             # run
```

## Scripts

```bash
npm run dev     # auto-restart on changes
npm run lint    # ESLint
npm run format  # Prettier --write
```

## Project Steps

See [plans/project-plan.md](plans/project-plan.md) for the full plan.

1. Local ingestion app — YouTube → GCS
2. Cloud Function — enriches with Claude on upload
3. Data Cloud — harmonizes into Contact records
4. Agentforce + Playback Room + Coach Room
