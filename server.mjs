import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import OpenAI from 'openai';
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3030);
const appName = process.env.APP_NAME || 'Relay';
const ownerName = process.env.OWNER_NAME || 'the account owner';
if (process.env.NODE_ENV === 'production' && (!process.env.APP_PASSWORD || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('Refusing to start publicly: set APP_PASSWORD and a SESSION_SECRET of at least 32 characters.');
  process.exit(1);
}
const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, webhookSecret: process.env.OPENAI_WEBHOOK_SECRET })
  : null;
const activeCalls = new Map();
const seenWebhooks = new Set();
let lastOutboundAt = 0;

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb', verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(session({
  name: 'relay.sid',
  secret: process.env.SESSION_SECRET || 'local-development-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 60 * 60 * 1000 }
}));

const loginAttempts = new Map();
function passwordMatches(input) {
  const expected = process.env.APP_PASSWORD || '';
  if (!expected || typeof input !== 'string') return false;
  const provided = Buffer.from(input);
  const actual = Buffer.from(expected);
  return provided.length === actual.length && timingSafeEqual(provided, actual);
}

app.get('/login', (_req, res) => res.sendFile(path.join(here, 'public', 'login.html')));
app.post('/auth/login', (req, res) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 15 * 60 * 1000; }
  if (attempt.count >= 10) return res.status(429).redirect('/login?error=slowdown');
  attempt.count++;
  loginAttempts.set(key, attempt);
  if (!passwordMatches(req.body?.password)) return res.status(401).redirect('/login?error=incorrect');
  loginAttempts.delete(key);
  req.session.regenerate(err => {
    if (err) return res.status(500).send('Could not start a secure session.');
    req.session.authenticated = true;
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).send('Could not start a secure session.');
      res.redirect('/');
    });
  });
});

function requireLogin(req, res, next) {
  if (req.session?.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in to use Relay.' });
  return res.redirect('/login');
}

app.get('/auth/logout', requireLogin, (req, res) => req.session.destroy(() => res.redirect('/login')));

function configMissing() {
  const missing = [];
  if (!process.env.APP_PASSWORD) missing.push('app sign-in password');
  if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) missing.push('32-character session secret');
  if (!process.env.OPENAI_API_KEY) missing.push('OpenAI API key');
  if (!process.env.SIP_PROVIDER_URL || !process.env.SIP_USERNAME || !process.env.SIP_PASSWORD || !process.env.SIP_CALLER_NUMBER) missing.push('SIP trunk settings');
  return missing;
}

function instructions({ purpose, inbound = false }) {
  const role = inbound
    ? `You are ${appName}, an AI voice assistant answering a call on behalf of ${ownerName}.`
    : `You are ${appName}, an AI voice assistant calling on behalf of ${ownerName}.`;
  return `${role}
At the beginning of every call, clearly and naturally say that you are an AI assistant. Never pretend to be ${ownerName} or a human. Speak warmly, briefly, and conversationally, with natural pauses. If asked, explain that you are an AI voice assistant.
${inbound ? 'Ask the caller what they need. Take a concise message or help arrange a callback. Do not claim that a callback is confirmed.' : `The sole purpose of this call is: ${purpose}. Keep the conversation to this purpose.`}
Do not make promises, accept terms, spend money, disclose private information, or agree to meetings or other commitments on the owner's behalf. You may ask what time works and report it as a suggestion, but say the owner must confirm. If the person asks not to speak with an AI, apologize, end politely, and do not continue. If the call is misdirected or they do not want the call, apologize and end promptly. Do not record or claim to record this call.`;
}

function validateE164(value) {
  return typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);
}

async function liveRequest(endpoint, body) {
  if (!client) throw new Error('Add OPENAI_API_KEY to the .env file first.');
  const response = await fetch(`https://api.openai.com/v1/live/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Live API request failed (${response.status}).`);
  return data;
}

function attachSideband(sessionId, call) {
  const ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  });
  call.ws = ws;
  ws.on('open', () => {
    call.status = 'connected';
    call.updatedAt = new Date().toISOString();
    ws.send(JSON.stringify({ type: 'response.create' }));
  });
  ws.on('message', raw => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return; }
    if (event.type === 'transport.ringing') call.status = 'ringing';
    if (event.type === 'transport.answered') call.status = 'connected';
    if (event.type === 'transport.failed') {
      call.status = 'failed';
      call.error = event.error?.message || event.error?.code || 'The phone provider could not connect this call.';
    }
    if (event.type === 'session.closed') call.status = 'ended';
    call.updatedAt = new Date().toISOString();
  });
  ws.on('error', err => { call.error = err.message; });
  ws.on('close', () => { if (call.status !== 'failed') call.status = 'ended'; call.updatedAt = new Date().toISOString(); });
}

function ready(req, res, next) {
  const missing = configMissing();
  if (missing.length) return res.status(503).json({ error: `Set up ${missing.join(' and ')} before placing calls.` });
  next();
}

app.get('/api/status', requireLogin, (_req, res) => {
  res.json({ ready: configMissing().length === 0, missing: configMissing(), inboundEnabled: process.env.INBOUND_ENABLED === 'true', activeCalls: [...activeCalls.values()].map(({ ws, ...call }) => call) });
});

app.post('/api/calls', requireLogin, ready, async (req, res) => {
  const { to, purpose, consent } = req.body || {};
  if (!consent) return res.status(400).json({ error: 'Confirm you are authorized to call this person before placing the call.' });
  if (!validateE164(to)) return res.status(400).json({ error: 'Enter a phone number in international format, such as +14155550123.' });
  if (typeof purpose !== 'string' || purpose.trim().length < 4 || purpose.length > 600) return res.status(400).json({ error: 'Add a short, clear reason for the call (4–600 characters).' });
  if (Date.now() - lastOutboundAt < 30_000) return res.status(429).json({ error: 'Please wait 30 seconds between outgoing calls.' });
  if ([...activeCalls.values()].some(c => ['starting', 'ringing', 'connected'].includes(c.status))) return res.status(409).json({ error: 'Finish the active call before starting another.' });
  lastOutboundAt = Date.now();
  try {
    const result = await liveRequest('sessions', {
      session: {
        model: 'gpt-live-1',
        instructions: instructions({ purpose: purpose.trim() }),
        audio: { output: { voice: 'marin' } },
        delegation: { type: 'responses', responses: { model: process.env.OPENAI_RESPONSES_MODEL || 'gpt-5.6-sol', instructions: 'Respond briefly and naturally as a voice assistant. Follow the live session instructions. Do not invent facts or take actions.' } },
        input: [{ role: 'user', content: [{ type: 'input_text', text: `Call purpose: ${purpose.trim()}. Start by identifying yourself as an AI assistant calling on behalf of ${ownerName}, then ask whether they can talk.` }] }],
        store: false
      },
      transport: {
        type: 'sip', destination: to,
        trunk: {
          provider_url: process.env.SIP_PROVIDER_URL,
          auth: { type: 'digest', username: process.env.SIP_USERNAME, password: process.env.SIP_PASSWORD },
          caller_number: process.env.SIP_CALLER_NUMBER
        }
      }
    });
    const id = result?.session?.id;
    if (!id) throw new Error('The voice service did not return a call session.');
    const call = { id, direction: 'outbound', to, purpose: purpose.trim(), status: 'starting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    activeCalls.set(id, call);
    attachSideband(id, call);
    return res.status(201).json({ id, status: call.status, message: 'Call request sent to your SIP provider.' });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Could not start the call.' });
  }
});

app.post('/api/calls/:id/end', requireLogin, ready, async (req, res) => {
  const call = activeCalls.get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call session not found in this app.' });
  try {
    await liveRequest(`sessions/${encodeURIComponent(call.id)}/hangup`, {});
    call.status = 'ended';
    call.ws?.close();
    return res.json({ status: 'ended' });
  } catch (err) { return res.status(502).json({ error: err.message }); }
});

app.post('/webhooks/openai', async (req, res) => {
  if (!client || !process.env.OPENAI_WEBHOOK_SECRET) return res.status(503).send('Webhook is not configured.');
  let event;
  try { event = await client.webhooks.unwrap(req.rawBody.toString('utf8'), req.headers); }
  catch { return res.status(400).send('Invalid webhook signature.'); }
  if (seenWebhooks.has(event.id)) return res.status(200).send('Already handled.');
  seenWebhooks.add(event.id);
  if (seenWebhooks.size > 5000) seenWebhooks.clear();
  const isIncoming = event.type === 'live.transport.incoming' || event.type === 'live.call.incoming';
  if (!isIncoming) return res.status(200).send('Ignored.');
  const sessionId = event.data?.session_id || event.data?.call_id;
  if (!sessionId) return res.status(400).send('Missing call session.');
  if (process.env.INBOUND_ENABLED !== 'true') {
    try { await liveRequest(`sessions/${encodeURIComponent(sessionId)}/reject`, { status_code: 486 }); }
    catch (err) { console.error('Could not reject incoming call:', err.message); }
    return res.status(200).send('Incoming calls are disabled.');
  }
  try {
    await liveRequest(`sessions/${encodeURIComponent(sessionId)}/accept`, {
      session: {
        type: 'live', model: 'gpt-live-1', instructions: instructions({ inbound: true }),
        audio: { output: { voice: 'marin' } },
        delegation: { type: 'responses', responses: { model: process.env.OPENAI_RESPONSES_MODEL || 'gpt-5.6-sol', instructions: 'Respond briefly and naturally as a voice assistant. Follow the live session instructions. Take messages; never claim a callback or commitment is confirmed.' } },
        input: [{ role: 'user', content: [{ type: 'input_text', text: `A caller has just connected. Greet them by identifying yourself as an AI assistant for ${ownerName}, then ask how you can help.` }] }], store: false
      }
    });
    const call = { id: sessionId, direction: 'inbound', status: 'connected', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    activeCalls.set(sessionId, call);
    attachSideband(sessionId, call);
    return res.status(200).send('Accepted.');
  } catch (err) {
    console.error('Could not accept incoming call:', err.message);
    return res.status(500).send('Could not accept call.');
  }
});

app.get('/', requireLogin, (_req, res) => res.sendFile(path.join(here, 'public', 'index.html')));
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/') || req.path.startsWith('/auth/')) return res.status(404).end();
  return requireLogin(req, res, () => res.sendFile(path.join(here, 'public', 'index.html')));
});

app.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`${appName} call assistant listening on ${process.env.HOST || '127.0.0.1'}:${port}`);
  const missing = configMissing();
  if (!process.env.APP_PASSWORD) console.log('Setup required: set APP_PASSWORD before signing in.');
  if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) console.log('Setup required: SESSION_SECRET must be at least 32 characters in production.');
  if (missing.length) console.log(`Setup required: ${missing.join(', ')}`);
});
