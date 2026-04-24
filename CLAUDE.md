# CLAUDE.md — Real Housewives Reunion Ready

## Project Overview

Multi-agent AI pipeline for the SYTYCAI contest. Ingests Real Housewives reunion transcripts, enriches with Claude drama analysis, harmonizes in Salesforce Data Cloud, and surfaces through a headless Agentforce chatbot + an ElevenLabs audio playback page.

## Repository Structure

```
housewives-sytycai/
├── server.js           # Express entry point (mounts route modules)
├── routes/             # transcribe.js, playback.js, coach.js
├── lib/                # storage.js (shared GCP Storage client)
├── public/             # index.html, coach.html, playback.html, style.css, *.js
├── cloud-function/     # main.py (enrichment + CSV), backfill_csv.py, deploy docs
├── plans/project-plan.md
├── README.md
└── CLAUDE.md
```

## Key Design Decisions

- **Bravo Producer Persona** — theatrical, not corporate. Deliberate contest differentiator.
- **Event-Driven Enrichment** — Cloud Function triggers on `object.finalize` in the raw bucket, writes to enriched bucket. Two buckets prevent re-trigger loops.
- **Local-Only Ingestion** — YouTube blocks cloud IPs; the Node app runs on localhost. The hosted pipeline starts at GCS.
- **Data Cloud as Source of Truth** — Housewife profiles live as Salesforce Contact records via Data Cloud harmonization.

## GCP Cloud Function

- Runtime: Python 3.12, 2nd-gen, `us-east1`
- Trigger: `google.cloud.storage.object.v1.finalized` on `sytycai-video-transcripts`
- `ANTHROPIC_API_KEY` sourced from Secret Manager in prod; `.env` locally
- Deploy command in [cloud-function/README.md](cloud-function/README.md)

## Claude API

- Model: `claude-sonnet-4-6`, prompt caching on system prompt
- Structured output via tool-use (`save_drama_profiles`)
- Schema per cast member: `housewife_name`, `gender`, `drama_score` (0–100), `feuds`, `key_moments`, `talking_points`, `confessional_draft`
- Canonical-name rule: `housewife_name` must exactly match the provided Cast list

## Playback Room (`/playback`)

- `GET /api/housewives` reads enriched bucket → flat list with `gender` field
- `POST /api/speak` accepts `{text, gender}` → routes to female (Carolina) or male (Min Diesel) ElevenLabs voice → streams MP3
- Server-side TTS cache: `sha256(voiceId + text)` → Buffer (survives page refresh, doesn't re-charge credits)
- Client-side audio cache: item index → blob URL (repeat plays are instant, no network hit)
- Env vars: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (Carolina default), `ELEVENLABS_MALE_VOICE_ID` (Min Diesel default)

## Coach Room (`/coach`)

- Headless Agentforce — Bravo-branded chat, no Salesforce Lightning shell
- **JWT Bearer** flow required — `AgentforceEmployeeAgent` type can't use `client_credentials`
- `npm` dep: `jsonwebtoken`
- `server.key` / `server.crt` are gitignored; cert uploaded to Connected App
- Per-user token cache in memory; `extractText()` flattens copilot action payloads into the reply
- Falls back to a lock screen if any `SF_*` env var is missing
- Env vars: `SF_INSTANCE_URL`, `SF_CLIENT_ID`, `SF_AGENT_ID`, `SF_DEFAULT_USERNAME`, `SF_PRIVATE_KEY_PATH` (or `SF_PRIVATE_KEY`), `SF_AUDIENCE`

## Salesforce / Agentforce

- One Contact per cast member; custom fields: `Drama_Score__c`, `Key_Feuds__c`, `AI_Talking_Points__c`, `Season__c`, `Confessional_Draft__c`
- Agent topic: "Reunion Prep Coach" — seasoned Bravo producer persona
