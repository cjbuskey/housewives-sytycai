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

### Form fields

| Field                  | Required | Purpose                                                                                            |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| YouTube URL            | ✅       | The video to transcribe                                                                            |
| Franchise              | –        | e.g. `Real Housewives of Salt Lake City`                                                           |
| Season                 | –        | Season number                                                                                      |
| Episode Title          | –        | e.g. `Reunion Part 1`                                                                              |
| **Cast**               | –        | Comma-separated Housewives in this reunion. Anchors Claude's speaker attribution.                  |
| **Additional Context** | –        | Free-form producer notes about the season — storylines, new cast members, anything worth flagging. |

The Cast and Additional Context fields get passed to Claude as grounding context during enrichment, which significantly improves drama profile accuracy for ambiguous moments.

### Optional: speaker hints (advanced)

After looking at the enriched output, if you notice Claude mis-attributing specific moments, you can hand-edit the raw transcript JSON in GCS and add a `speaker_hints` array:

```json
{
  "transcript": "...",
  "cast": ["Heather Gay", "Lisa Barlow", "..."],
  "speaker_hints": [
    "Any line about 'my lawsuit' is Monica.",
    "The host asking questions is Andy Cohen, not a Housewife.",
    "The moment about the stairs is Heather talking about Monica."
  ]
}
```

Then re-upload the file to re-trigger enrichment. See [cloud-function/README.md](cloud-function/README.md#input-json-optional-grounding-fields) for full details. This field is intentionally not on the form — it's an iterative refinement you'd only do after seeing initial output.

## Playback Room

A second page in the same Node app that reads an enriched Housewife's AI-drafted confessional aloud using ElevenLabs. It's the audio payoff for the demo.

Open <http://localhost:3000/playback> once the server's running.

**Setup (one-time):**

1. Sign up at [elevenlabs.io](https://elevenlabs.io)
2. Profile → API Keys → create a key
3. (Optional) browse **Voice Library** for a voice that fits — the default `ELEVENLABS_VOICE_ID` in `.env.example` is Matilda, a theatrical pre-made voice
4. Set these in your `.env`:
   ```
   ELEVENLABS_API_KEY=sk_...
   ELEVENLABS_VOICE_ID=<voice id>
   ```
5. Restart `npm start`

**How it works:**

- `GET /api/housewives` — reads every file in `gs://sytycai-video-transcripts-enriched/` and returns a flat list of Housewife + confessional entries
- The `/playback` page groups those by Housewife with a searchable list UI
- Click a row → see her confessional text → hit **PLAY**
- `POST /api/speak` proxies the text to ElevenLabs and streams the MP3 back to the browser

**Scripts:**

```bash
npm run dev           # auto-restart on file changes
npm run lint          # ESLint
npm run format        # Prettier --write
```

## Coach Room (Headless Agentforce)

A third page at <http://localhost:3000/coach> that embeds the Agentforce Reunion Prep Coach directly in the Bravo UI — no Salesforce Lightning shell needed.

The Coach Room uses the **JWT Bearer** OAuth flow to open agent sessions as a real Salesforce user. This is required for the `AgentforceEmployeeAgent` type (client_credentials can't open sessions against it).

**One-time setup:**

1. Generate an RSA key pair:
   ```bash
   openssl genrsa -out server.key 2048
   openssl req -new -x509 -key server.key -out server.crt -days 365
   ```
2. In your Salesforce org, create a **Connected App** with:
   - OAuth scopes: `api`, `refresh_token`, `einstein_genie_api` (Agentforce)
   - Enable **Use Digital Signature** and upload `server.crt`
   - Enable **JWT Bearer** and pre-authorise the user you'll run sessions as
3. Set these in your `.env` (see `.env.example` for full comments):
   ```
   SF_INSTANCE_URL=https://yourorg.my.salesforce.com
   SF_CLIENT_ID=<Connected App consumer key>
   SF_AGENT_ID=<18-char Agentforce agent id>
   SF_DEFAULT_USERNAME=<salesforce username>
   SF_PRIVATE_KEY_PATH=server.key   # gitignored — never commit
   ```
4. Restart `npm start`

If any `SF_*` var is missing, `/coach` shows a lock screen rather than a broken chat, and the Salesforce-native chat UI remains available as a fallback.

**How it works:**

- `GET /api/agent/config` — tells the frontend whether the Coach Room is configured
- `POST /api/agent/session` — opens an Agentforce session, returns `sessionId` + opening greeting
- `POST /api/agent/ask` — sends a user message, returns the agent's reply; opens a new session automatically if `sessionId` is absent

## Project Steps

See [plans/project-plan.md](plans/project-plan.md) for the full plan.

1. Local ingestion app — accepts YouTube URLs, stores transcripts in GCP
2. Cloud Function — auto-triggers on upload, enriches with Claude
3. Data Cloud — ingests enriched data, harmonizes with Contact records
4. Agentforce — Reunion Prep Coach with Bravo producer persona
