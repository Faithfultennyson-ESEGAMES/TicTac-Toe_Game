const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = Number.parseInt(process.env.CATCHER_PORT, 10) || 3101;
const HMAC_SECRET = process.env.HMAC_SECRET || '';
const EVENT_LIMIT = Number.parseInt(process.env.EVENT_LIMIT, 10) || 5000;
const STORE_FILE = path.join(__dirname, 'captured.ndjson');

const events = [];
let sequence = 0;

function safeEqualHex(a, b) {
  try {
    const aa = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function verifySignature(raw, supplied) {
  if (!HMAC_SECRET) return null;
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(raw).digest('hex');
  return safeEqualHex(expected, supplied);
}

function record(entry) {
  const item = {
    id: ++sequence,
    receivedAt: new Date().toISOString(),
    ...entry,
  };
  events.push(item);
  while (events.length > EVENT_LIMIT) events.shift();
  try {
    fs.appendFileSync(STORE_FILE, `${JSON.stringify(item)}\n`);
  } catch (error) {
    console.error('[Catcher] Could not persist event:', error.message);
  }
  console.log(`[Catcher] ${item.kind} ${item.eventType || ''} ${item.sessionId || ''} signature=${item.signatureValid}`);
  return item;
}

function parseRawJson(req, res) {
  const raw = req.body;
  const text = raw.toString('utf8');
  try {
    return { raw, body: JSON.parse(text) };
  } catch {
    res.status(400).json({ error: 'Invalid JSON body.' });
    return null;
  }
}

app.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const parsed = parseRawJson(req, res);
  if (!parsed) return;
  const eventId = req.get('X-Event-Id') || null;
  const eventType = req.get('X-Event-Type') || 'unknown';
  const suppliedSignature = req.get('X-Hub-Signature-256') || '';
  const signatureValid = verifySignature(parsed.raw, suppliedSignature);
  const sessionId = parsed.body?.sessionId || null;

  record({
    kind: 'dispatcher',
    eventId,
    eventType,
    sessionId,
    signatureValid,
    body: parsed.body,
  });

  res.status(204).end();
});

app.post('/session-closed', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const parsed = parseRawJson(req, res);
  if (!parsed) return;
  const suppliedSignature = req.get('X-Hub-Signature-256') || '';
  const signatureValid = verifySignature(parsed.raw, suppliedSignature);
  const sessionId = parsed.body?.sessionId || null;

  record({
    kind: 'session-closed',
    eventId: null,
    eventType: 'session.closed',
    sessionId,
    signatureValid,
    body: parsed.body,
  });

  res.status(204).end();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    hmacConfigured: Boolean(HMAC_SECRET),
    captured: events.length,
  });
});

app.get('/api/events', (req, res) => {
  const after = Number.parseInt(req.query.after, 10) || 0;
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : null;
  const eventType = req.query.eventType ? String(req.query.eventType) : null;
  let result = events.filter((event) => event.id > after);
  if (sessionId) result = result.filter((event) => event.sessionId === sessionId);
  if (eventType) result = result.filter((event) => event.eventType === eventType);
  res.json(result);
});

app.get('/api/summary', (req, res) => {
  const bySession = {};
  for (const event of events) {
    const key = event.sessionId || '(none)';
    if (!bySession[key]) {
      bySession[key] = {
        sessionId: event.sessionId,
        total: 0,
        dispatcher: 0,
        sessionClosed: 0,
        invalidSignatures: 0,
        eventTypes: {},
      };
    }
    const item = bySession[key];
    item.total += 1;
    if (event.kind === 'dispatcher') item.dispatcher += 1;
    if (event.kind === 'session-closed') item.sessionClosed += 1;
    if (event.signatureValid === false) item.invalidSignatures += 1;
    item.eventTypes[event.eventType] = (item.eventTypes[event.eventType] || 0) + 1;
  }
  res.json(Object.values(bySession));
});

app.delete('/api/events', (req, res) => {
  events.length = 0;
  sequence = 0;
  try { fs.writeFileSync(STORE_FILE, ''); } catch {}
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`[Catcher] listening on http://localhost:${PORT}`);
  console.log(`[Catcher] HMAC verification: ${HMAC_SECRET ? 'enabled' : 'disabled'}`);
});
