# Real Housewives Reunion Ready — Project Plan

**Contest:** So You Think You Can AI (SYTYCAI)
**Team:** Linda Nichols + teammate
**Theme:** Real Housewives reunion transcript intelligence + Agentforce Drama Coach

---

## Overview

Four-step pipeline: ingest → enrich → harmonize → agent.

### Event-Driven Architecture

Enrichment is triggered automatically by a GCP Cloud Function — no manual step required. Two buckets keep the trigger loop clean:

```
Local ingestion app (Node.js)
    │ upload raw transcript
    ▼
GCS: sytycai-video-transcripts/           ← Cloud Function trigger (object.finalize)
    │ reads file, calls Claude API
    ▼
GCS: sytycai-video-transcripts-enriched/  ← Data Cloud watches this bucket
    │
    ▼
Data Cloud data stream → Contact harmonization → Agentforce
```

---

## Step 1 — Transcript Ingestion (Local Node.js + GCP)

**Goal:** A local web app where you paste a YouTube URL and get a transcript stored in GCP Cloud Storage.

### Tasks

- [x] Scaffold a Node.js app with Express, served from `localhost:3000`
- [x] Fetch transcripts via YouTube's InnerTube API (native `fetch`, no package dependency)
- [x] Set up GCP Cloud Storage bucket (`sytycai-video-transcripts`)
- [x] On form submit: extract transcript → upload as `{show}-{season}-{episode}-{timestamp}.json` to GCP
- [x] Display confirmation with GCP file path and transcript preview
- [x] Seed 15 RHOSLC reunion episodes into GCS for the demo

### Output Schema (stored in GCP)

```json
{
  "source_url": "https://youtube.com/...",
  "show": "Real Housewives of Beverly Hills",
  "season": 13,
  "episode_title": "Reunion Part 1",
  "extracted_at": "2026-04-18T00:00:00Z",
  "transcript": "...(full text)..."
}
```

---

## Step 2 — AI Drama Enrichment (GCP Cloud Function + Claude)

**Goal:** A Cloud Function fires automatically when a raw transcript lands in GCS, enriches it with Claude, and writes the result to the enriched bucket — no manual trigger needed.

### GCP Setup

- [x] Create second bucket: `sytycai-video-transcripts-enriched`
- [x] Deploy a Cloud Function (Python or Node.js, 2nd gen) to the same GCP project
- [x] Set trigger: `google.cloud.storage.object.v1.finalized` on `sytycai-video-transcripts` bucket
- [x] Grant the Cloud Function's service account read access to `sytycai-video-transcripts` and write access to `sytycai-video-transcripts-enriched`
- [x] Store the Anthropic API key in GCP Secret Manager; bind it to the function

### Function Logic

- [x] On trigger: download the raw JSON file from GCS
- [x] Call Claude with the transcript as user message (system prompt cached)
- [x] Parse and validate the JSON response
- [x] Upload enriched output to `sytycai-video-transcripts-enriched/` as `{original-filename}-enriched.json`
- [x] Log success/failure to Cloud Logging

### Claude Enrichment

Actual prompt, tool schema, and logic live in [cloud-function/main.py](../cloud-function/main.py). Summary:

- Model: `claude-sonnet-4-6`, prompt caching enabled on the system prompt
- Structured output via tool use (`save_drama_profiles`) — guarantees valid JSON
- Output schema per Housewife: `housewife_name`, `drama_score` (0-100), `feuds`, `key_moments`, `talking_points`, `confessional_draft`
- Canonical-name rule: `housewife_name` must exactly match the `cast` list from the user message
- Grounding fields threaded through from the ingestion form: `show`, `season`, `episode_title`, `cast`, `notes`, `speaker_hints`

---

## Step 3 — Data Cloud Ingestion + Salesforce Harmonization

**Goal:** Ingest enriched profiles into Salesforce Data Cloud and link them to Contact records.

### Salesforce Contact Setup

- One Contact per Housewife (use show names, e.g., "Erika Jayne", "Sutton Stracke")
- Custom fields to add to Contact:
  - `Drama_Score__c` (Number)
  - `Key_Feuds__c` (Long Text Area)
  - `AI_Talking_Points__c` (Long Text Area)
  - `Season__c` (Text)
  - `Confessional_Draft__c` (Long Text Area)

### Data Cloud Tasks

- [x] Create a Data Cloud data stream pointed at the `sytycai-video-transcripts-enriched` GCS bucket
- [x] Map enrichment fields to Contact custom fields
- [x] Set up identity resolution (match on `housewife_name`)
- [x] Run harmonization to produce unified Housewife profiles
- [x] Verify Contact records are populated via Salesforce UI

---

## Step 4 — Agentforce Reunion Prep Coach

**Goal:** An Agentforce agent with a Bravo-producer persona that answers reunion prep questions using the unified Housewife profiles.

### Persona Design

The agent should feel like a seasoned Bravo producer — theatrical, knowing, slightly conspiratorial. Not a corporate assistant. Example voice:

> _"Oh honey, Erika is coming in hot tonight. Her drama score is 87 — second highest this season. She's going to bring up the lawsuit if anyone mentions Tom, so have your comebacks ready. Here are three..."_

### Agent Topics & Actions

**Topic 1: Reunion Briefing**

- Trigger: "Brief me on [Housewife]" / "Who should I watch out for?"
- Action: Query Contact record, return drama score + key feuds + talking points in producer voice

**Topic 2: Comeback Generator**

- Trigger: "Give me comebacks if [Housewife] mentions [topic]"
- Action: Claude generates 3 witty, on-brand comebacks based on drama profile

**Topic 3: Feud Map**

- Trigger: "Who's feuding with who?" / "What's the tea this season?"
- Action: Aggregate feuds across all Contacts, return a drama web summary

**Topic 4: Confessional Generator** ⭐ (Bonus)

- Trigger: "Write [Housewife]'s confessional" / "What should Erika say in her talking-head?"
- Action: Return `Confessional_Draft__c` from Contact, optionally send to ElevenLabs for voice

### ElevenLabs Integration — "Playback Room"

**Goal:** Pick a cast member, see their AI confessional, hit ▶ — confessional reads aloud. Demo's audio payoff moment.

**Tasks:**

- [x] `GET /api/housewives` — reads enriched bucket, returns flat list with `gender` field
- [x] `POST /api/speak` — accepts `{text, gender}`, routes to Carolina (female) or Min Diesel (male), streams MP3
- [x] Server-side TTS cache: `sha256(voiceId + text)` → Buffer (repeat plays don't burn quota)
- [x] Client-side audio cache: item index → blob URL (instant replay, no network hit)
- [x] `public/playback.html` + `public/playback.js` — searchable list UI, Bravo aesthetic
- [x] `gender` field added to Cloud Function schema; existing files bulk-patched in GCS

### Headless Agentforce — "Coach Room" ✅

**Goal:** Bravo-branded chat at `/coach` wired directly to the Agentforce agent — no Salesforce Lightning shell.

Uses **JWT Bearer** OAuth (`AgentforceEmployeeAgent` requires a real user context; `client_credentials` can't open sessions against it).

**Tasks (all done):**

- [x] Connected App with `einstein_genie_api` scope, Digital Signature cert, JWT Bearer enabled
- [x] `jsonwebtoken` npm dep; `server.key`/`server.crt` gitignored
- [x] `GET /api/agent/config`, `POST /api/agent/session`, `POST /api/agent/ask` in `server.js`
- [x] Per-user token cache; `extractText()` flattens copilot action payloads
- [x] `public/coach.html` + `public/coach.js` — suggested-prompt chips, eager session open on load
- [x] Falls back to lock screen if `SF_*` vars missing; Salesforce-native chat remains fallback

### Sample Prompts to Demo

| Prompt                                                | Expected Response                                             |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| "Brief me on Erika before tonight"                    | Drama score, feuds, top 3 talking points, producer commentary |
| "What's Sutton likely to bring up?"                   | Key moments from Sutton's profile, predicted topics           |
| "Give me three comebacks if she mentions the lawsuit" | 3 witty, character-appropriate comebacks                      |
| "Write Erika's confessional"                          | Dramatic talking-head script in Erika's voice                 |
| "Who's the biggest villain this season?"              | Ranked drama scores with commentary                           |

---

## Demo Flow (Contest Presentation)

Single browser tab: `http://localhost:3000` with three linked pages. Keep Salesforce org open in a second tab only to briefly show Contact records.

1. **`/` (ingestion)** — paste a YouTube URL, submit. Show transcript landing in GCS. Note the Cloud Function auto-triggers. _(Demo data was pre-seeded; live scrape is for show.)_
2. Show an enriched JSON briefly — drama scores, feuds, confessional drafts.
3. **(Salesforce tab)** — Contact record with custom fields populated by Data Cloud harmonization.
4. **`/coach`** — ask _"Brief me on Sutton before tonight"_ → Bravo-producer voice, drama score, feuds, talking points.
5. Ask _"Give me three comebacks if she mentions the shop"_ → Comeback Generator.
6. Ask _"Who's feuding this season?"_ → Feud Map.
7. **`/playback`** — pick Sutton → hit ▶ → confessional reads aloud in Carolina's voice. Drop the mic.

**Talking point:** "We took Data Cloud + Agentforce and made them do something completely unexpected — and completely unforgettable."

---

## Future / Post-Contest

### Unit Testing

Scope to pure logic functions only — no mocking of GCS, ElevenLabs, or Salesforce.

**Node (Jest):** `extractVideoId`, `slugify`, `extractText` (Agentforce response flattener)

**Browser (Jest + jsdom):** `abbreviateShow`, `itemMatchesFilter`, `rowLabel`

**Python (pytest):** `build_user_message` (grounding field threading into Claude prompt)

Skip route-level tests — they're thin wrappers around external services with low signal-to-setup ratio for a demo codebase.

### Per-Franchise Voice Accents (finalist live demo polish)

Route `/api/speak` to a different ElevenLabs voice based on the show, so confessionals sound like they're from the right city.

| Franchise | Voice vibe | Env var |
| --------- | ---------- | ------- |
| RHONJ     | New York / Jersey accent | `ELEVENLABS_VOICE_ID_NJ` |
| RHOBH     | SoCal / Malibu ease | `ELEVENLABS_VOICE_ID_BH` |
| RHOSLC    | Current default (Carolina) | `ELEVENLABS_VOICE_ID` |

**Implementation sketch:**
- Add a `show` field to the `/api/speak` request body (already available on each item in `/api/housewives`)
- In `server.js`, map franchise slug → voice ID env var, fall back to the default female voice if unset
- Audition voices in ElevenLabs Voice Library; save IDs to `.env`
- Server-side TTS cache already keys on `voiceId + text`, so franchise voices are cached independently — no extra work needed
