# CLAUDE.md — Real Housewives Reunion Ready

## Project Overview

Multi-agent AI pipeline for the "So You Think You Can AI" (SYTYCAI) contest. Ingests Real Housewives reunion transcripts, enriches them with Claude drama analysis, harmonizes in Salesforce Data Cloud, and surfaces through an Agentforce chatbot + an ElevenLabs audio playback page.

## Repository Structure

```
housewives-sytycai/
├── server.js                 # Express app (ingestion + /coach + /playback APIs)
├── public/                   # Frontend (index.html, coach.html, playback.html, style.css, ...)
├── cloud-function/           # Python enrichment Cloud Function (main.py + deploy docs)
├── plans/project-plan.md     # Full implementation plan + demo flow
├── .github/workflows/ci.yml  # Lint + format check on push/PR
├── README.md                 # Setup + run instructions
└── CLAUDE.md                 # This file
```

## Key Design Decisions

- **Bravo Producer Persona**: Agentforce agent must feel theatrical, not corporate. Deliberate contest differentiator.
- **Event-Driven Enrichment**: Cloud Function triggers on `object.finalize` in the raw bucket (`sytycai-video-transcripts`), writes output to a separate enriched bucket (`sytycai-video-transcripts-enriched`). Two buckets prevent the function from re-triggering on its own output.
- **Local-Only Ingestion**: The Node ingestion app runs on localhost, not a deployed host — YouTube blocks cloud-provider IPs. Hosted pipeline starts at GCS.
- **Data Cloud as Source of Truth**: Housewife profiles live as Salesforce Contact records, enriched via Data Cloud harmonization.
- **ElevenLabs Playback Room**: Separate `/playback` page in the Node app (not in Agentforce chat). Reads confessionals aloud — the demo's audio payoff moment.

## Development Phases

| Phase  | Goal                                                                    |
| ------ | ----------------------------------------------------------------------- |
| Step 1 | Local Node.js ingestion app → YouTube transcript → GCP Storage          |
| Step 2 | GCP Cloud Function (event-driven) → Claude enrichment → enriched bucket |
| Step 3 | Data Cloud ingestion + Contact harmonization                            |
| Step 4 | Agentforce Reunion Prep Coach + ElevenLabs Playback Room                |

## GCP Cloud Function Notes

- Runtime: Python 3.12, 2nd-gen function, deployed to `us-east1`
- Trigger: `google.cloud.storage.object.v1.finalized` on `sytycai-video-transcripts`
- Anthropic API key stored in Secret Manager (`anthropic-api-key`), mounted as `ANTHROPIC_API_KEY` env var
- Full deploy command in [cloud-function/README.md](cloud-function/README.md)

## Claude API Usage Notes

- Model: `claude-sonnet-4-6` (long transcripts, cost/quality balance)
- Prompt caching enabled on the system prompt (constant across invocations)
- Structured output via tool-use (`save_drama_profiles`), guaranteed JSON
- Output schema per Housewife: `housewife_name`, `drama_score` (0-100), `feuds`, `key_moments`, `talking_points`, `confessional_draft`
- Canonical name rule: `housewife_name` must exactly match an entry in the Cast list when provided (no abbreviations, no misspellings)

## ElevenLabs Playback Room Notes

- Lives in the same Node app at `/playback`
- `GET /api/housewives` reads the enriched bucket, returns a flat list grouped by Housewife in the UI
- `POST /api/speak` proxies text to ElevenLabs TTS, streams MP3 back to the browser
- Env vars: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`

## Coach Room Notes

- Lives at `/coach` in the same Node app
- Uses **JWT Bearer** OAuth — required for `AgentforceEmployeeAgent` (Internal Copilot); `client_credentials` can't open sessions against that type
- `npm` dependency: `jsonwebtoken`
- Env vars: `SF_INSTANCE_URL`, `SF_CLIENT_ID`, `SF_AGENT_ID`, `SF_DEFAULT_USERNAME`, `SF_PRIVATE_KEY_PATH` (or `SF_PRIVATE_KEY`), `SF_AUDIENCE`
- `server.key` and `server.crt` are gitignored — generate locally, upload cert to the Connected App
- Per-user token cache in memory; tokens live ~58 min (JWT exp = 5 min, but access token lasts ~1 hr)
- `extractText()` in server.js flattens copilot action output payloads (briefings, confessionals) so the full response reaches the UI
- If any `SF_*` var is missing, `/coach` shows a lock screen — Salesforce-native chat remains the fallback

## Salesforce / Agentforce Notes

- One Contact record per Housewife (show names)
- Custom fields on Contact: `Drama_Score__c`, `Key_Feuds__c`, `AI_Talking_Points__c`, `Season__c`, `Confessional_Draft__c`
- Agent topic: "Reunion Prep Coach"
- Persona: seasoned Bravo producer — theatrical, knowing, slightly conspiratorial
