require('dotenv').config();

const express = require('express');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

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
// Optional: if SF_* env vars are set, /coach talks to the Agentforce agent
// directly via the Einstein Agent API. If anything is missing, /api/agent/config
// reports unconfigured and the UI falls back to a link to the Salesforce-hosted
// chat.

const AGENT_API_BASE = 'https://api.salesforce.com/einstein/ai-agent/v1';

function agentEnv() {
  const { SF_INSTANCE_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_AGENT_ID } = process.env;
  return {
    instanceUrl: SF_INSTANCE_URL && SF_INSTANCE_URL.replace(/\/+$/, ''),
    clientId: SF_CLIENT_ID,
    clientSecret: SF_CLIENT_SECRET,
    agentId: SF_AGENT_ID,
    configured: Boolean(SF_INSTANCE_URL && SF_CLIENT_ID && SF_CLIENT_SECRET && SF_AGENT_ID),
  };
}

let cachedToken = null; // { accessToken, instanceUrl, expiresAt }

async function getAgentToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken;

  const { instanceUrl, clientId, clientSecret } = agentEnv();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const r = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Salesforce token request failed (${r.status}): ${text}`);
  }

  const data = await r.json();
  const ttlMs = (data.expires_in ? data.expires_in * 1000 : null) || 2 * 60 * 60 * 1000;
  cachedToken = {
    accessToken: data.access_token,
    instanceUrl: data.instance_url || instanceUrl,
    expiresAt: Date.now() + ttlMs,
  };
  return cachedToken;
}

async function openAgentSession(token, agentId) {
  const r = await fetch(`${AGENT_API_BASE}/agents/${agentId}/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      externalSessionKey: `coach-room-${Date.now()}`,
      instanceConfig: { endpoint: token.instanceUrl },
      streamingCapabilities: { chunkTypes: ['Text'] },
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Agent session open failed (${r.status}): ${text}`);
  }
  return r.json(); // { sessionId, messages: [...] }
}

async function sendAgentMessage(token, sessionId, text, sequenceId) {
  const r = await fetch(`${AGENT_API_BASE}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: { sequenceId, type: 'Text', text },
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Agent message failed (${r.status}): ${body}`);
  }
  return r.json(); // { messages: [{ message, type, ... }] }
}

function extractText(response) {
  const msgs = response?.messages || [];
  return msgs
    .map((m) => m?.message || m?.text || '')
    .filter(Boolean)
    .join('\n\n');
}

app.get('/coach', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'coach.html'));
});

app.get('/api/agent/config', (_req, res) => {
  res.json({ configured: agentEnv().configured });
});

app.post('/api/agent/ask', async (req, res) => {
  const env = agentEnv();
  if (!env.configured) {
    return res.status(503).json({
      error: 'Coach Room is not configured. Set SF_* env vars or use the Salesforce chat.',
    });
  }

  const { text, sessionId } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const token = await getAgentToken();

    let sid = sessionId;
    let greeting = '';

    if (!sid) {
      const session = await openAgentSession(token, env.agentId);
      sid = session.sessionId;
      greeting = extractText(session);
    }

    const reply = await sendAgentMessage(token, sid, text, Date.now());
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
