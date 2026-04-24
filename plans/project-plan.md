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

- Recommend caching generated audio by confessional text hash so the demo doesn't regenerate on every button press.

**Use for (out of scope for initial build, keep in mind):**

- Re-narration of `key_moments` in addition to confessionals
- Audio intro/outro for the reunion briefing ("Tonight on the reunion…")

### Headless Agentforce — "Coach Room" (Optional Enhancement)

**Goal:** Skip the Salesforce-hosted chat UI entirely and embed the Agentforce agent behind a third page in the local Node app (`/coach`), styled in the Bravo aesthetic. The demo collapses from 3 tabs to 1, judges never see a Salesforce Lightning shell, and the entire experience feels like one polished product.

**Why consider it:**

- **Unified demo surface** — ingestion, coach, and playback all live at `localhost:3000/*`. One URL, one polished look.
- **On-brand chat UI** — hot pink + gold + serif aesthetic for the chat, not the corporate Salesforce Lightning chrome.
- **No org access needed at presentation time** — judges don't need to be logged into Salesforce to see the agent.
- **Reusable infra** — same pattern works for embedding agents in any product UI down the road.

**Why you might skip it:**

- More moving parts = more demo risk. The Salesforce-hosted chat UI is already working and battle-tested.
- Requires a Connected App + OAuth setup in the Salesforce org, which adds admin overhead.
- You lose the "wow, it's really in Agentforce" moment judges might appreciate seeing natively.

**Architecture:**

```
/coach page (Node app)
   │
   ├── Chat UI (Bravo-themed, same style tokens as /playback)
   │
   └── POST /api/agent/ask → Salesforce Connected App auth →
          Agentforce REST API → response text back
```

**Auth note:** `AgentforceEmployeeAgent` (Internal Copilot) requires a real user context — the `client_credentials` flow cannot open sessions against it. The implementation uses **JWT Bearer**, which signs an assertion with an RSA private key and exchanges it for a user-scoped access token.

**Salesforce side (one-time setup):**

- [x] Create a Connected App with Agentforce API scope (`einstein_genie_api`)
- [x] Enable **Use Digital Signature**, upload the self-signed `server.crt`
- [x] Enable JWT Bearer and pre-authorise the user who will run sessions
- [x] Capture `SF_INSTANCE_URL`, `SF_CLIENT_ID`, `SF_AGENT_ID`, `SF_DEFAULT_USERNAME`

**Node app tasks:**

- [x] Add `jsonwebtoken` npm dependency
- [x] Add env vars to `.env.example` and `.env` (`SF_PRIVATE_KEY_PATH`, `SF_PRIVATE_KEY`, `SF_AUDIENCE`, `SF_DEFAULT_USERNAME`)
- [x] Add `GET /coach` route in `server.js`
- [x] Add `GET /api/agent/config` — reports configured/unconfigured + `defaultUsername`
- [x] Add `POST /api/agent/session` — opens a new session, returns `sessionId` + opening greeting
- [x] Add `POST /api/agent/ask` — sends a message; auto-opens session if `sessionId` absent
- [x] Per-user token cache with JWT assertion refresh
- [x] `extractText()` flattens copilot action output payloads (briefings, confessionals) into the reply
- [x] Create `public/coach.html` — Bravo-branded chat layout with suggested-prompt chips
- [x] Create `public/coach.js` — eager session open on page load so producer greets on arrival
- [x] Wire `/coach` links into `index.html` and `playback.html`
- [x] Gitignore `server.key` and `server.crt`

**Demo flow implication:**

The 3-tab demo collapses to a single browser tab — `localhost:3000` with three linked pages (`/`, `/coach`, `/playback`). Salesforce Contact records can still be shown briefly from the Salesforce org to prove the data pipeline is real, but the agent experience lives entirely in the Bravo-branded UI.

**Fallback safety:** If any `SF_*` var is missing, `/coach` shows a lock screen rather than a broken chat. The Salesforce-native chat UI remains available as a tab-swap fallback during the demo.

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
