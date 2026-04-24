require('dotenv').config();

const express = require('express');
const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── GCP STORAGE ─────────────────────────────────────────────────────────────
// Single Storage client, lazily created on first use and reused across requests.

let storageClient;

function getStorage() {
  if (storageClient) return storageClient;

  const options = {};
  if (process.env.GOOGLE_CLOUD_CREDENTIALS) {
    try {
      options.credentials = JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS);
    } catch {
      throw new Error(
        'GOOGLE_CLOUD_CREDENTIALS is set but is not valid JSON. ' +
          'Either fix the value or unset it and use GOOGLE_APPLICATION_CREDENTIALS (file path) instead.'
      );
    }
  }
  if (process.env.GOOGLE_CLOUD_PROJECT_ID) {
    options.projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  }

  storageClient = new Storage(options);
  return storageClient;
}

// ─── YOUTUBE TRANSCRIPT ───────────────────────────────────────────────────────
// Uses YouTube's InnerTube API (same approach as youtube-transcript package).
// Native fetch available in Node 18+, no extra dependency needed.

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36';

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '\u0022')
    .replace(/&#39;/g, '\u0027')
    .replace(/&apos;/g, '\u0027')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function parseTranscriptXml(xml, lang) {
  const segments = [];
  // New TTML format: <p t="ms" d="ms">...</p>
  const newFmt = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = newFmt.exec(xml)) !== null) {
    const text = decodeEntities(m[3].replace(/<[^>]+>/g, '')).trim();
    if (text) segments.push({ offset: parseInt(m[1]), duration: parseInt(m[2]), text, lang });
  }
  if (segments.length) return segments;
  // Legacy XML format: <text start="s" dur="s">...</text>
  const oldFmt = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
  while ((m = oldFmt.exec(xml)) !== null) {
    segments.push({
      offset: Math.round(parseFloat(m[1]) * 1000),
      duration: Math.round(parseFloat(m[2]) * 1000),
      text: decodeEntities(m[3]),
      lang,
    });
  }
  return segments;
}

async function fetchTranscript(videoId) {
  const res = await fetch(INNERTUBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': ANDROID_UA },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
      videoId,
    }),
  });

  if (!res.ok) throw new Error(`YouTube API responded with ${res.status}`);

  const data = await res.json();
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) throw new Error('No transcripts are available for this video.');

  const trackUrl = tracks[0].baseUrl;
  const lang = tracks[0].languageCode || 'en';

  const xmlRes = await fetch(trackUrl, { headers: { 'User-Agent': BROWSER_UA } });
  if (!xmlRes.ok) throw new Error('Failed to fetch transcript data from YouTube.');

  const xml = await xmlRes.text();
  const segments = parseTranscriptXml(xml, lang);
  if (!segments.length) throw new Error('Transcript was empty or could not be parsed.');
  return segments;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  const m = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.post('/api/transcribe', async (req, res) => {
  const { url, showName, episodeTitle, season, cast, notes } = req.body;

  if (!url) return res.status(400).json({ error: 'YouTube URL is required, darling.' });

  const videoId = extractVideoId(url);
  if (!videoId)
    return res
      .status(400)
      .json({ error: 'That URL is giving us nothing. Try a valid YouTube link.' });

  try {
    const segments = await fetchTranscript(videoId);
    const fullText = segments.map((s) => s.text).join(' ');

    const show = showName || 'Real Housewives';
    const episode = episodeTitle || 'episode';
    const filename = `${slugify(show)}-s${season || '0'}-${slugify(episode)}-${Date.now()}.json`;

    const castList =
      typeof cast === 'string' && cast.trim()
        ? cast
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null;

    const transcriptData = {
      source_url: url,
      video_id: videoId,
      show,
      season: season ? parseInt(season) : null,
      episode_title: episodeTitle || null,
      cast: castList,
      notes: notes && notes.trim() ? notes.trim() : null,
      extracted_at: new Date().toISOString(),
      word_count: (fullText.trim().match(/\S+/g) || []).length,
      transcript: fullText,
      segments,
    };

    const bucket = getStorage().bucket(process.env.GCS_RAW_BUCKET || 'sytycai-video-transcripts');
    await bucket.file(filename).save(JSON.stringify(transcriptData, null, 2), {
      contentType: 'application/json',
    });

    res.json({
      success: true,
      filename,
      gcsPath: `gs://${process.env.GCS_RAW_BUCKET || 'sytycai-video-transcripts'}/${filename}`,
      wordCount: transcriptData.word_count,
      preview: fullText.slice(0, 600),
    });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch transcript.' });
  }
});

// ─── PLAYBACK ROOM ────────────────────────────────────────────────────────────

app.get('/playback', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'playback.html'));
});

// Reads all enriched files from the enriched bucket, returns a flat list of
// Housewife confessionals with show/season metadata for the Playback Room UI.
app.get('/api/housewives', async (_req, res) => {
  try {
    const enrichedBucketName =
      process.env.GCS_ENRICHED_BUCKET || 'sytycai-video-transcripts-enriched';
    const bucket = getStorage().bucket(enrichedBucketName);
    const [files] = await bucket.getFiles();

    const perFile = await Promise.all(
      files
        .filter((f) => f.name.endsWith('.json'))
        .map(async (file) => {
          try {
            const [contents] = await file.download();
            const data = JSON.parse(contents.toString());
            const source = data.source || {};
            return (data.profiles || [])
              .filter((p) => p && p.confessional_draft)
              .map((p) => ({
                show: source.show || data.franchise || 'Real Housewives',
                season: source.season ?? null,
                episode_title: source.episode_title || null,
                housewife: p.housewife_name,
                drama_score: p.drama_score ?? null,
                confessional: p.confessional_draft,
                source_file: file.name,
              }));
          } catch (err) {
            console.warn(`Skipping ${file.name}: ${err.message}`);
            return [];
          }
        })
    );

    const items = perFile.flat();
    res.json({ count: items.length, items });
  } catch (err) {
    console.error('Housewives list error:', err);
    res.status(500).json({ error: err.message || 'Failed to list housewives.' });
  }
});

// Proxies text to ElevenLabs TTS and streams the MP3 back to the browser.
app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not set.' });
  }
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'XrExE9yKIg1WjnnlVkGX'; // Matilda

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75,
          style: 0.6,
          use_speaker_boost: true,
        },
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error(`ElevenLabs API error ${r.status}:`, errText);
      return res
        .status(r.status)
        .json({ error: `ElevenLabs returned ${r.status}. Check your API key and quota.` });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    console.error('Speak error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate audio.' });
  }
});

// ─── COACH ROOM (HEADLESS AGENTFORCE) ─────────────────────────────────────────
// /coach talks to an Agentforce Internal Copilot / Employee Agent via the
// Einstein Agent API. Uses the JWT Bearer flow so each session runs as a real
// Salesforce user (required for Internal Copilot agents — client_credentials
// can't open sessions against them).

const AGENT_API_BASE = 'https://api.salesforce.com/einstein/ai-agent/v1';

function loadPrivateKey() {
  if (process.env.SF_PRIVATE_KEY_PATH) {
    const p = path.resolve(__dirname, process.env.SF_PRIVATE_KEY_PATH);
    return fs.readFileSync(p, 'utf8');
  }
  if (process.env.SF_PRIVATE_KEY) {
    return process.env.SF_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  return null;
}

function agentEnv() {
  const { SF_INSTANCE_URL, SF_CLIENT_ID, SF_AGENT_ID, SF_AUDIENCE, SF_DEFAULT_USERNAME } =
    process.env;
  const privateKey = loadPrivateKey();
  return {
    instanceUrl: SF_INSTANCE_URL && SF_INSTANCE_URL.replace(/\/+$/, ''),
    clientId: SF_CLIENT_ID,
    agentId: SF_AGENT_ID,
    audience: SF_AUDIENCE || 'https://login.salesforce.com',
    defaultUsername: SF_DEFAULT_USERNAME || null,
    privateKey,
    configured: Boolean(SF_INSTANCE_URL && SF_CLIENT_ID && SF_AGENT_ID && privateKey),
  };
}

// Per-user token cache: username -> { accessToken, instanceUrl, expiresAt }
const tokenCache = new Map();

async function getAccessToken(username) {
  const now = Date.now();
  const cached = tokenCache.get(username);
  if (cached && cached.expiresAt > now + 60_000) return cached;

  const env = agentEnv();
  if (!env.privateKey) throw new Error('SF_PRIVATE_KEY_PATH is not set or file is unreadable.');

  const assertion = jwt.sign(
    {
      iss: env.clientId,
      sub: username,
      aud: env.audience,
      exp: Math.floor(now / 1000) + 300,
    },
    env.privateKey,
    { algorithm: 'RS256' }
  );

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const r = await fetch(`${env.instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`JWT OAuth failed (${r.status}): ${text}`);
  }

  const data = await r.json();
  const token = {
    accessToken: data.access_token,
    instanceUrl: data.instance_url || env.instanceUrl,
    expiresAt: now + 3500 * 1000,
  };
  tokenCache.set(username, token);
  return token;
}

// sessionId -> username (so we know which token to use for follow-up messages)
const sessionUsers = new Map();

async function openAgentSession(username) {
  const env = agentEnv();
  const token = await getAccessToken(username);

  const r = await fetch(`${AGENT_API_BASE}/agents/${env.agentId}/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      externalSessionKey: crypto.randomUUID(),
      instanceConfig: { endpoint: env.instanceUrl },
      streamingCapabilities: { chunkTypes: ['Text'] },
      bypassUser: false,
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Agent session open failed (${r.status}): ${text}`);
  }
  const session = await r.json();
  sessionUsers.set(session.sessionId, username);
  return session;
}

async function sendAgentMessage(sessionId, text, sequenceId) {
  const username = sessionUsers.get(sessionId);
  if (!username) throw new Error('Unknown session. Start a new one.');
  const token = await getAccessToken(username);

  const r = await fetch(`${AGENT_API_BASE}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: { sequenceId, type: 'Text', text },
      variables: [],
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Agent message failed (${r.status}): ${body}`);
  }
  return r.json();
}

// Flatten an agent message into displayable text, pulling from:
//   - m.message / m.text (top-level reply)
//   - m.data[].value.*   (copilot action outputs — e.g. briefing, confessional)
//   - m.result[].value.* (legacy action result shape)
// Strings inside those payload objects are appended after the top-level reply
// so the UI sees the full briefing, not just the teaser.
function extractPayloadStrings(items) {
  const out = [];
  for (const item of items || []) {
    const v = item?.value;
    if (!v) continue;
    if (typeof v === 'string') {
      out.push(v);
    } else if (typeof v === 'object') {
      for (const val of Object.values(v)) {
        if (typeof val === 'string' && val.trim()) out.push(val);
      }
    }
  }
  return out;
}

function extractText(response) {
  const msgs = response?.messages || [];
  const parts = [];
  for (const m of msgs) {
    const top = m?.message || m?.text;
    if (top) parts.push(top);
    parts.push(...extractPayloadStrings(m?.data));
    parts.push(...extractPayloadStrings(m?.result));
  }
  return parts.filter(Boolean).join('\n\n');
}

app.get('/coach', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'coach.html'));
});

app.get('/api/agent/config', (_req, res) => {
  const env = agentEnv();
  res.json({
    configured: env.configured,
    defaultUsername: env.defaultUsername,
  });
});

app.post('/api/agent/session', async (req, res) => {
  const env = agentEnv();
  if (!env.configured) {
    return res.status(503).json({ error: 'Coach Room is not configured.' });
  }
  try {
    const user = (req.body && req.body.username) || env.defaultUsername;
    if (!user) {
      return res
        .status(400)
        .json({ error: 'username is required (or set SF_DEFAULT_USERNAME).' });
    }
    const session = await openAgentSession(user);
    res.json({
      sessionId: session.sessionId,
      greeting: extractText(session),
    });
  } catch (err) {
    console.error('Agent session error:', err);
    res.status(502).json({ error: err.message || 'Agent session failed.' });
  }
});

app.post('/api/agent/ask', async (req, res) => {
  const env = agentEnv();
  if (!env.configured) {
    return res.status(503).json({
      error: 'Coach Room is not configured. Set SF_* env vars and SF_PRIVATE_KEY_PATH.',
    });
  }

  const { text, sessionId, username } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    let sid = sessionId;
    let greeting = '';

    if (!sid) {
      const user = username || env.defaultUsername;
      if (!user) {
        return res
          .status(400)
          .json({ error: 'username is required to start a session (or set SF_DEFAULT_USERNAME).' });
      }
      const session = await openAgentSession(user);
      sid = session.sessionId;
      greeting = extractText(session);
    }

    const reply = await sendAgentMessage(sid, text, Date.now());
    const replyText = extractText(reply);

    res.json({
      sessionId: sid,
      reply: replyText,
      greeting: greeting || undefined,
    });
  } catch (err) {
    console.error('Agent ask error:', err);
    res.status(502).json({ error: err.message || 'Agent call failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`Reunion Ready is serving looks on port ${PORT} 💅`);
});
