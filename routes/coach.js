const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const router = express.Router();

const AGENT_API_BASE = 'https://api.salesforce.com/einstein/ai-agent/v1';

function loadPrivateKey() {
  if (process.env.SF_PRIVATE_KEY_PATH) {
    const p = path.resolve(__dirname, '..', process.env.SF_PRIVATE_KEY_PATH);
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
    { iss: env.clientId, sub: username, aud: env.audience, exp: Math.floor(now / 1000) + 300 },
    env.privateKey,
    { algorithm: 'RS256' }
  );

  const r = await fetch(`${env.instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
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

// sessionId -> username mapping so follow-up messages use the right token
const sessionUsers = new Map();

async function openAgentSession(username) {
  const env = agentEnv();
  const token = await getAccessToken(username);

  const r = await fetch(`${AGENT_API_BASE}/agents/${env.agentId}/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
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
    headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { sequenceId, type: 'Text', text }, variables: [] }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Agent message failed (${r.status}): ${body}`);
  }
  return r.json();
}

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

router.get('/coach', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'coach.html'));
});

router.get('/api/agent/config', (_req, res) => {
  const env = agentEnv();
  res.json({ configured: env.configured, defaultUsername: env.defaultUsername });
});

router.post('/api/agent/session', async (req, res) => {
  const env = agentEnv();
  if (!env.configured) return res.status(503).json({ error: 'Coach Room is not configured.' });

  try {
    const user = (req.body && req.body.username) || env.defaultUsername;
    if (!user)
      return res.status(400).json({ error: 'username is required (or set SF_DEFAULT_USERNAME).' });

    const session = await openAgentSession(user);
    res.json({ sessionId: session.sessionId, greeting: extractText(session) });
  } catch (err) {
    console.error('Agent session error:', err);
    res.status(502).json({ error: err.message || 'Agent session failed.' });
  }
});

router.post('/api/agent/ask', async (req, res) => {
  const env = agentEnv();
  if (!env.configured) {
    return res
      .status(503)
      .json({ error: 'Coach Room is not configured. Set SF_* env vars and SF_PRIVATE_KEY_PATH.' });
  }

  const { text, sessionId, username } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

  try {
    let sid = sessionId;
    let greeting = '';

    if (!sid) {
      const user = username || env.defaultUsername;
      if (!user)
        return res.status(400).json({
          error: 'username is required to start a session (or set SF_DEFAULT_USERNAME).',
        });
      const session = await openAgentSession(user);
      sid = session.sessionId;
      greeting = extractText(session);
    }

    const reply = await sendAgentMessage(sid, text, Date.now());
    res.json({ sessionId: sid, reply: extractText(reply), greeting: greeting || undefined });
  } catch (err) {
    console.error('Agent ask error:', err);
    res.status(502).json({ error: err.message || 'Agent call failed.' });
  }
});

module.exports = router;
module.exports.extractText = extractText;
