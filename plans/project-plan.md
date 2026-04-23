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

> **Why two buckets?** If enriched files land in the same bucket as raw files, the Cloud Function would re-trigger on its own output. Separate buckets eliminate that loop with no filtering logic needed.

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
- [] Log success/failure to Cloud Logging

### Claude Enrichment Prompt (system)

```
You are a drama analyst for Bravo TV. Given a Real Housewives reunion transcript,
extract a structured drama profile for each Housewife mentioned. Be specific,
cite moments from the transcript, and score drama objectively.

Output valid JSON only. Schema:
[
  {
    "housewife_name": "string",
    "drama_score": 0-100,
    "feuds": ["name: description"],
    "key_moments": ["quote or scene description"],
    "talking_points": ["point 1", "point 2"],
    "confessional_draft": "string — what she should say in her next talking-head"
  }
]
```

### Model

- Use `claude-sonnet-4-6` for cost/quality balance on long transcripts
- Enable prompt caching on the system prompt — transcripts are long and the system prompt is constant

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

- [ ] Create a Data Cloud data stream pointed at the `sytycai-video-transcripts-enriched` GCS bucket
- [ ] Map enrichment fields to Contact custom fields
- [ ] Set up identity resolution (match on `housewife_name`)
- [ ] Run harmonization to produce unified Housewife profiles
- [ ] Verify Contact records are populated via Salesforce UI

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

### ElevenLabs Integration — "Playback Room" (Bonus)

**Goal:** A dedicated page in the local Node.js app where you pick a Housewife, see her AI-generated confessional, and play it aloud in a dramatic voice. Closes the demo with a memorable audio "ta-da" moment.

**Architecture:**

```
/playback page
   │
   ├── Dropdown populated from GET /api/housewives
   │     (reads gs://sytycai-video-transcripts-enriched/)
   │
   ├── Shows confessional_draft text when a Housewife is picked
   │
   └── "Play" button → POST /api/speak → ElevenLabs API → MP3 streamed back
```

**Tasks:**

- [x] Sign up at elevenlabs.io, grab API key (free tier = ~10k chars/mo, plenty for demo)
- [x] Audition 3–4 voices for Bravo-narrator energy (Matilda, Charlotte, Charlie are worth trying); commit to one `voice_id`
- [x] Add `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` to `.env.example` and `.env`
- [x] Add new Express route `GET /api/housewives` — reads enriched bucket, returns a grouped list: `[{show, season, housewives: [{name, confessional}]}]`
- [x] Add new Express route `POST /api/speak` — takes `{text}`, calls ElevenLabs `/v1/text-to-speech/{voice_id}`, streams the MP3 response back to the browser
- [x] Create `public/playback.html` — dropdown + confessional preview + play button, matching the existing Bravo aesthetic
- [x] Create `public/playback.js` — fetch housewives list on load, wire up the play button to an `<audio>` element
- [x] Add a navigation link from `index.html` to `/playback`
- [ ] Optional polish: cache generated MP3s locally so repeat plays don't burn quota

**Demo payoff:**

After the Agentforce chat demo ends ("Brief me on Meredith…"), click over to the Playback Room and let Meredith's AI-written confessional play in a dramatic voice. Hands-off theatrical moment — judges _hear_ the output instead of just reading it.

**Cost/quota notes:**

- ElevenLabs free tier: 10,000 characters/month. A single confessional is ~300 chars → ~33 plays per month before hitting the cap.
- Recommend caching generated audio by confessional text hash so the demo doesn't regenerate on every button press.

**Use for (out of scope for initial build, keep in mind):**

- Re-narration of `key_moments` in addition to confessionals
- Audio intro/outro for the reunion briefing ("Tonight on the reunion…")

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

Run with **three browser tabs** staged and ready:

- **Tab A:** Local ingestion app → `http://localhost:3000`
- **Tab B:** Agentforce chat (in Salesforce org)
- **Tab C:** Playback Room → `http://localhost:3000/playback`

**The flow:**

1. **Tab A (ingestion)** — paste a YouTube reunion URL, submit. Show the transcript land in GCS. Mention the Cloud Function auto-triggers from here. _(This is the "see it work live" moment — actual demo data was pre-seeded to avoid YouTube blocking the live scrape.)_
2. Briefly show the enriched JSON that the Cloud Function produced — drama scores, feuds, confessional drafts per Housewife.
3. **(Salesforce)** show the Contact record for a Housewife with the custom fields populated by Data Cloud harmonization.
4. **Tab B (Agentforce)** — ask _"Brief me on Meredith before tonight"_ → agent responds in Bravo-producer voice with her drama score, feuds, talking points.
5. Ask _"Give me three comebacks if she mentions the shop"_ → Comeback Generator in action.
6. Ask _"Who's feuding with who this season?"_ → Feud Map shows the drama web.
7. Ask _"Write Meredith's confessional"_ → agent returns the AI-drafted talking-head script as text.
8. **Tab C (Playback Room)** — the audio payoff. Pick Meredith → hit ▶ PLAY → her confessional reads aloud in Carolina's voice. Drop the mic.

**Talking point for judges:** "We took Data Cloud + Agentforce and made them do something completely unexpected — and completely unforgettable."

---

## Timeline Estimate

| Phase                                       | Effort    |
| ------------------------------------------- | --------- |
| Step 1 (Local app + GCP)                    | 1-2 days  |
| Step 2 (Cloud Function + Claude enrichment) | 1-2 days  |
| Step 3 (Data Cloud + Contacts)              | 2-3 days  |
| Step 4 (Agentforce agent)                   | 2-3 days  |
| ElevenLabs bonus                            | 0.5-1 day |
| Demo polish                                 | 0.5 day   |

---

## Open Questions / Decisions Needed

- [x] Which franchise(es) to use? (RHOBH is a strong choice — high drama, lots of reunion content)
- [x] Which YouTube episodes/reunions to ingest for the demo?
- [x] Who owns the Data Cloud / Agentforce org setup?
- [x] Which GCP project/region to deploy into?
- [x] Who owns GCP credentials and Secret Manager setup?
- [x] ElevenLabs voice selection — which voice fits a Bravo narrator?
