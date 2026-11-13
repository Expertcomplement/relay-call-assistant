import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3030);
const appName = process.env.APP_NAME || 'Relay';
const ownerName = process.env.OWNER_NAME || 'the account owner';
const voiceProvider = (process.env.VOICE_PROVIDER || 'vapi').toLowerCase();
if (!['vapi', 'openai_live'].includes(voiceProvider)) {
  console.error('VOICE_PROVIDER must be either vapi or openai_live.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && (!process.env.APP_PASSWORD || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('Refusing to start publicly: set APP_PASSWORD and a SESSION_SECRET of at least 32 characters.');
  process.exit(1);
}
let OpenAIClient = null;
let WebSocket = null;
if (voiceProvider === 'openai_live') {
  try {
    const [openai, ws] = await Promise.all([import('openai'), import('ws')]);
    OpenAIClient = openai.default;
    WebSocket = ws.default;
  } catch { console.error('Install the optional openai and ws packages to use VOICE_PROVIDER=openai_live.'); process.exit(1); }
}
const client = voiceProvider === 'openai_live' && process.env.OPENAI_API_KEY
  ? new OpenAIClient({ apiKey: process.env.OPENAI_API_KEY, webhookSecret: process.env.OPENAI_WEBHOOK_SECRET })
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
  if (voiceProvider === 'vapi') {
    if (!process.env.VAPI_API_KEY) missing.push('Vapi private API key');
    if (!process.env.VAPI_ASSISTANT_ID) missing.push('Vapi assistant ID');
    if (!process.env.VAPI_PHONE_NUMBER_ID) missing.push('Vapi phone number ID');
    if (process.env.INBOUND_ENABLED === 'true' && !process.env.VAPI_WEBHOOK_SECRET) missing.push('Vapi webhook credential');
  } else {
    if (!process.env.OPENAI_API_KEY) missing.push('OpenAI API key');
    if (!process.env.SIP_PROVIDER_URL || !process.env.SIP_USERNAME || !process.env.SIP_PASSWORD || !process.env.SIP_CALLER_NUMBER) missing.push('SIP trunk settings');
    if (process.env.INBOUND_ENABLED === 'true' && !process.env.OPENAI_WEBHOOK_SECRET) missing.push('OpenAI webhook signing secret');
  }
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

async function vapiRequest(endpoint, { method = 'POST', body } = {}) {
  if (!process.env.VAPI_API_KEY) throw new Error('Add VAPI_API_KEY to the server environment first.');
  const response = await fetch(`https://api.vapi.ai${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `Vapi request failed (${response.status}).`);
  return data;
}

function vapiModelOverride(prompt) {
  return {
    provider: process.env.VAPI_MODEL_PROVIDER || 'google',
    model: process.env.VAPI_MODEL || 'gemini-2.5-flash',
    messages: [{ role: 'system', content: prompt }]
  };
}

function vapiAssistantOverrides(prompt, firstMessage) {
  const voiceProvider = process.env.VAPI_VOICE_PROVIDER || 'vapi';
  const voice = {
    provider: voiceProvider,
    voiceId: process.env.VAPI_VOICE_ID || 'Elliot'
  };
  if (voiceProvider === 'vapi') voice.version = Number(process.env.VAPI_VOICE_VERSION || 2);
  return {
    model: vapiModelOverride(prompt),
    transcriber: {
      provider: process.env.VAPI_TRANSCRIBER_PROVIDER || 'deepgram',
      model: process.env.VAPI_TRANSCRIBER_MODEL || 'nova-3'
    },
    voice,
    firstMessage
  };
}

function vapiStatus(status, endedReason = '') {
  if (status === 'queued' || status === 'scheduled') return 'starting';
  if (status === 'ringing') return 'ringing';
  if (status === 'in-progress' || status === 'forwarding') return 'connected';
  if (status === 'ended' && String(endedReason).includes('error')) return 'failed';
  if (status === 'ended') return 'ended';
  return 'starting';
}

function secureControlUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.vapi.ai') ? url.toString() : null;
  } catch { return null; }
}

function vapiWebhookAuthorized(req) {
  const secret = process.env.VAPI_WEBHOOK_SECRET || '';
  const authorization = req.get('authorization') || '';
  const provided = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${secret}`);
  return Boolean(secret) && provided.length === expected.length && timingSafeEqual(provided, expected);
}

function rememberCall(call) {
  activeCalls.set(call.id, call);
  if (activeCalls.size <= 100) return;
  const completed = [...activeCalls.values()]
    .filter(item => ['ended', 'failed'].includes(item.status))
    .sort((a, b) => Date.parse(a.updatedAt || a.createdAt) - Date.parse(b.updatedAt || b.createdAt));
  while (activeCalls.size > 100 && completed.length) activeCalls.delete(completed.shift().id);
}

async function syncVapiCalls() {
  if (voiceProvider !== 'vapi' || !process.env.VAPI_API_KEY) return;
  const now = Date.now();
  const running = [...activeCalls.values()].filter(call =>
    ['starting', 'ringing', 'connected'].includes(call.status) && now - (call.providerCheckedAt || 0) >= 4000
  );
  await Promise.all(running.map(async call => {
    call.providerCheckedAt = now;
    try {
      const remote = await vapiRequest(`/call/${encodeURIComponent(call.id)}`, { method: 'GET' });
      call.status = vapiStatus(remote.status, remote.endedReason);
      call.controlUrl = secureControlUrl(remote.monitor?.controlUrl) || call.controlUrl || null;
      call.to = call.to || remote.customer?.number || 'caller';
      call.updatedAt = remote.updatedAt || new Date().toISOString();
    } catch { /* Keep the last known state while the provider API is unavailable. */ }
  }));
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

app.get('/api/status', requireLogin, async (_req, res) => {
  await syncVapiCalls();
  res.json({ ready: configMissing().length === 0, missing: configMissing(), provider: voiceProvider, inboundEnabled: process.env.INBOUND_ENABLED === 'true', activeCalls: [...activeCalls.values()].map(({ ws, controlUrl, providerCheckedAt, ...call }) => call) });
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
    if (voiceProvider === 'vapi') {
      const result = await vapiRequest('/call', { body: {
        assistantId: process.env.VAPI_ASSISTANT_ID,
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        customer: { number: to },
        assistantOverrides: vapiAssistantOverrides(
          instructions({ purpose: purpose.trim() }),
          `Hi, I’m ${appName}, an AI assistant calling on behalf of ${ownerName}. Is now a good time to talk?`
        )
      } });
      if (!result?.id) throw new Error('Vapi did not return a call ID.');
      const call = {
        id: result.id,
        direction: 'outbound',
        to,
        purpose: purpose.trim(),
        status: vapiStatus(result.status),
        controlUrl: secureControlUrl(result.monitor?.controlUrl),
        createdAt: result.createdAt || new Date().toISOString(),
        updatedAt: result.updatedAt || new Date().toISOString()
      };
      rememberCall(call);
      return res.status(201).json({ id: result.id, status: call.status, message: 'Call request sent to Vapi.' });
    }
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
    rememberCall(call);
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
    if (voiceProvider === 'vapi') {
      if (!call.controlUrl) {
        const remote = await vapiRequest(`/call/${encodeURIComponent(call.id)}`, { method: 'GET' });
        call.controlUrl = secureControlUrl(remote?.monitor?.controlUrl);
      }
      if (!call.controlUrl) return res.status(409).json({ error: 'Vapi has not made a call control link available yet. Try again shortly.' });
      const ended = await fetch(call.controlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'end-call' }) });
      if (!ended.ok) throw new Error(`Vapi could not end the call (${ended.status}).`);
      call.status = 'ended';
      call.updatedAt = new Date().toISOString();
      return res.json({ status: 'ended' });
    }
    await liveRequest(`sessions/${encodeURIComponent(call.id)}/hangup`, {});
    call.status = 'ended';
    call.ws?.close();
    return res.json({ status: 'ended' });
  } catch (err) { return res.status(502).json({ error: err.message }); }
});

app.post('/webhooks/openai', async (req, res) => {
  if (voiceProvider !== 'openai_live') return res.status(404).send('OpenAI provider is not active.');
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
    rememberCall(call);
    attachSideband(sessionId, call);
    return res.status(200).send('Accepted.');
  } catch (err) {
    console.error('Could not accept incoming call:', err.message);
    return res.status(500).send('Could not accept call.');
  }
});

app.post('/webhooks/vapi', async (req, res) => {
  if (voiceProvider !== 'vapi') return res.status(404).send('Vapi provider is not active.');
  if (!vapiWebhookAuthorized(req)) return res.status(process.env.VAPI_WEBHOOK_SECRET ? 401 : 503).send('Webhook authentication failed.');
  const message = req.body?.message || {};
  const callData = message.call || {};
  const eventType = message.type;

  if (eventType === 'assistant-request') {
    if (process.env.INBOUND_ENABLED !== 'true') return res.status(200).json({ error: 'Incoming call answering is disabled.' });
    if (!process.env.VAPI_ASSISTANT_ID) return res.status(200).json({ error: 'The assistant is not configured.' });
    const id = callData.id;
    if (id) {
      const call = {
        id,
        direction: 'inbound',
        to: callData.customer?.number || 'caller',
        purpose: 'AI answering',
        status: 'starting',
        controlUrl: secureControlUrl(callData.monitor?.controlUrl),
        createdAt: callData.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      rememberCall(call);
    }
    return res.status(200).json({
      assistantId: process.env.VAPI_ASSISTANT_ID,
      assistantOverrides: vapiAssistantOverrides(
        instructions({ inbound: true }),
        `Hello, I’m ${appName}, an AI assistant answering on behalf of ${ownerName}. How can I help?`
      )
    });
  }

  if (eventType === 'status-update' || eventType === 'end-of-call-report') {
    const id = callData.id;
    if (id) {
      const old = activeCalls.get(id) || {};
      const now = new Date().toISOString();
      const incoming = callData.type === 'inboundPhoneCall' || old.direction === 'inbound';
      rememberCall({
        ...old,
        id,
        direction: incoming ? 'inbound' : 'outbound',
        to: old.to || callData.customer?.number || 'caller',
        purpose: old.purpose || (incoming ? 'AI answering' : 'AI call'),
        status: eventType === 'end-of-call-report' ? vapiStatus('ended', message.endedReason || callData.endedReason) : vapiStatus(message.status, callData.endedReason),
        controlUrl: secureControlUrl(callData.monitor?.controlUrl) || old.controlUrl || null,
        createdAt: old.createdAt || callData.createdAt || now,
        updatedAt: now
      });
    }
  }
  return res.status(200).send('Received.');
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
