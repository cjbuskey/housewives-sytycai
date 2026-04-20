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
  const { url, showName, episodeTitle, season } = req.body;

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

    const transcriptData = {
      source_url: url,
      video_id: videoId,
      show,
      season: season ? parseInt(season) : null,
      episode_title: episodeTitle || null,
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

app.listen(PORT, () => {
  console.log(`Reunion Ready is serving looks on port ${PORT} 💅`);
});
