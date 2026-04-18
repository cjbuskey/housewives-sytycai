# Real Housewives Reunion Ready — AI Drama Coach

> *"Brief me on Erika before tonight."*

A multi-agent AI pipeline that ingests Real Housewives reunion transcripts, maps drama arcs, and powers a Bravo-producer-voiced Agentforce reunion prep chatbot. Submitted for the **So You Think You Can AI** innovation contest.

---

## What It Does

This project transforms Real Housewives reunion episode transcripts into structured drama intelligence — then surfaces that intelligence through a theatrical Agentforce agent that helps you prep for any reunion like a Bravo producer would.

### Key Capabilities

- **Transcript Ingestion** — Submit a YouTube URL; the system generates a transcript and stores it in GCP Cloud Storage
- **AI Drama Enrichment** — Claude performs sentiment analysis and maps drama arcs, feuds, and key moments per Housewife
- **Unified Housewife Profile** — Transcripts are ingested into Salesforce Data Cloud and harmonized with Salesforce Contact records, producing a unified drama profile (drama score, key feuds, AI-generated talking points)
- **Reunion Prep Chatbot** — An Agentforce agent with a Bravo-producer persona answers questions like:
  - *"What's Sutton likely to bring up?"*
  - *"Give me three comebacks if she mentions the lawsuit."*
  - *"Who's feuding with who this season?"*
- **Confessional Generator** — The agent drafts a Housewife's next talking-head confessional based on her current drama profile
- **Voice Narration** — ElevenLabs re-narrates key moments with appropriate dramatic flair

---

## Architecture

Enrichment is fully event-driven — uploading a transcript automatically triggers the entire pipeline with no manual steps.

```
YouTube URL
    │
    ▼
[Heroku Web App]
    │  transcript extraction
    ▼
[GCS: sytycai-video-transcripts/]       ← upload triggers Cloud Function
    │
    ▼
[GCP Cloud Function]
    │  calls Claude API (drama arc analysis)
    ▼
[GCS: sytycai-video-transcripts-enriched/]  ← Data Cloud watches this bucket
    │
    ▼
[Salesforce Data Cloud / Data 360]
    │  ingestion + harmonization
    ▼
[Salesforce Contact Records]  ←─── drama score, feuds, talking points
    │
    ▼
[Agentforce Reunion Prep Coach]
    │
    ├── Chat Q&A (Bravo producer persona)
    ├── Confessional Generator
    └── ElevenLabs Voice Narration
```

> Two separate GCS buckets prevent the Cloud Function from re-triggering on its own enriched output.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend / Ingestion | Heroku web app |
| Transcript Storage | GCP Cloud Storage (2 buckets: raw + enriched) |
| Enrichment Trigger | GCP Cloud Function (event-driven, object.finalize) |
| AI Enrichment | Claude (Anthropic) |
| Voice Generation | ElevenLabs |
| CRM & Data Platform | Salesforce Data Cloud (Data 360) |
| AI Agent | Salesforce Agentforce |

---

## Project Steps

See [plans/project-plan.md](plans/project-plan.md) for the full detailed implementation plan.

1. **Step 1** — Heroku web app accepts YouTube URLs and stores raw transcripts in GCP
2. **Step 2** — GCP Cloud Function auto-triggers on upload, calls Claude, writes enriched file to second bucket
3. **Step 3** — Data Cloud ingestion + harmonization with Salesforce Contact records
4. **Step 4** — Agentforce Reunion Prep Coach with Bravo producer persona

---

## Contest: So You Think You Can AI

This project is designed to showcase:
- Creative, unexpected use of Agentforce and Data Cloud
- Heavy generative AI integration (Claude + ElevenLabs)
- A multi-agent pipeline with real data harmonization
- A memorable, theatrical AI persona that stands out from corporate demos
