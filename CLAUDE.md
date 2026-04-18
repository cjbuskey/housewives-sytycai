# CLAUDE.md — Real Housewives Reunion Ready

## Project Overview

A multi-agent AI pipeline for the "So You Think You Can AI" (SYTYCAI) contest at Salesforce. Ingests Real Housewives reunion transcripts, enriches them with Claude-powered drama arc analysis, harmonizes the data in Salesforce Data Cloud, and surfaces it through an Agentforce chatbot with a Bravo-producer persona.

## Repository Structure

```
housewives-sytycai/
├── plans/                  # Implementation plans and design docs
│   └── project-plan.md     # Full step-by-step project plan
├── README.md               # Project overview and architecture
└── CLAUDE.md               # This file
```

## Key Design Decisions

- **Bravo Producer Persona**: The Agentforce agent must feel theatrical, not corporate. Responses should be dramatic, witty, and producer-voiced. This is a deliberate creative choice for contest differentiation.
- **Event-Driven Enrichment**: A GCP Cloud Function triggers on `object.finalize` in the raw transcripts bucket (`sytycai-video-transcripts`), calls Claude, and writes output to a separate enriched bucket (`sytycai-video-transcripts-enriched`). Two buckets are required — one bucket would cause the function to re-trigger on its own output.
- **Claude for Enrichment**: Claude performs sentiment analysis and drama arc mapping on raw transcripts. Output schema should be structured JSON (drama score, feuds, key moments, talking points) for reliable Data Cloud ingestion.
- **Data Cloud as Source of Truth**: All Housewife profiles live as Salesforce Contact records enriched via Data Cloud harmonization — not in a bespoke database.
- **ElevenLabs for Voice**: Re-narration of key moments, and optionally the Confessional Generator output. Keep this as a bonus/polish feature, not a dependency for the core demo.

## Development Phases

| Phase | Goal |
|---|---|
| Step 1 | Heroku web app → YouTube transcript → GCP Storage |
| Step 2 | GCP Cloud Function (event-driven) → Claude enrichment → enriched bucket |
| Step 3 | Data Cloud ingestion + Contact harmonization |
| Step 4 | Agentforce agent + Confessional Generator |

## GCP Cloud Function Notes

- Runtime: Python 3.12 or Node.js 20 (2nd gen function)
- Trigger: `google.cloud.storage.object.v1.finalized` on `sytycai-video-transcripts` bucket
- IAM: function service account needs `storage.objects.get` on raw bucket, `storage.objects.create` on enriched bucket
- Anthropic API key: store in GCP Secret Manager, mount as env var — never hardcode
- Logging: use Cloud Logging for success/failure per file processed

## Claude API Usage Notes

- Use `claude-sonnet-4-6` for transcript enrichment (cost/quality balance for potentially long transcripts)
- Enable prompt caching on the system prompt — it's constant across all invocations and transcripts are long
- Output format for enrichment: structured JSON with fields: `housewife_name`, `drama_score` (0-100), `feuds` (array), `key_moments` (array), `talking_points` (array), `confessional_draft` (string)

## Salesforce / Agentforce Notes

- One Salesforce Contact record per Housewife (use fictional/show names)
- Custom fields on Contact: `Drama_Score__c`, `Key_Feuds__c`, `AI_Talking_Points__c`, `Season__c`
- Agentforce agent topic: "Reunion Prep Coach"
- Agent persona instruction: speak like a seasoned Bravo producer — theatrical, knowing, slightly conspiratorial

## Contest Context

- Contest: So You Think You Can AI (SYTYCAI) — internal Salesforce innovation contest
- Extra points for using Agentforce (at least one hook/integration)
- Judged on creativity, innovation, and technical depth
- Goal: be the most memorable demo in the room
