const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { getStorage } = require('../lib/storage');

const router = express.Router();

// In-memory TTS cache: sha256(voiceId + text) -> Buffer
// Keyed by content so voice changes naturally miss.
const ttsCache = new Map();

router.get('/playback', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'playback.html'));
});

router.get('/api/housewives', async (_req, res) => {
  try {
    const bucket = getStorage().bucket(
      process.env.GCS_ENRICHED_BUCKET || 'sytycai-video-transcripts-enriched'
    );
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
                gender: p.gender || 'female',
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

router.post('/api/speak', async (req, res) => {
  const { text, gender } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not set.' });
  }

  const isMale = gender === 'male';
  const voiceId = isMale
    ? process.env.ELEVENLABS_MALE_VOICE_ID || 'q3pCVYOxlOb5G3l2O13o' // Min Diesel
    : process.env.ELEVENLABS_VOICE_ID || 'VCUa8W1mPO0QcgrSewvs'; // Carolina

  const cacheKey = crypto
    .createHash('sha256')
    .update(voiceId + text)
    .digest('hex');
  const cached = ttsCache.get(cacheKey);
  if (cached) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', cached.length);
    return res.send(cached);
  }

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
    ttsCache.set(cacheKey, buf);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    console.error('Speak error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate audio.' });
  }
});

module.exports = router;
