
const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = 4000;

// In-memory store for webhook logs
const webhookLogs = new Map();

// --- Middleware ---

// Use express.raw for the webhook endpoint to verify HMAC
app.use(
  '/webhook',
  express.raw({ type: 'application/json' })
);

// Use express.json for all other routes
app.use(express.json());


// --- Helper Functions ---

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    console.warn('[WARN] HMAC_SECRET is not set in .env — cannot verify signature.');
    return false;
  }
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;

  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) return false;

  const received = signatureHeader.trim();
  const computedHex = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const expected = `${expectedPrefix}${computedHex}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

// --- Main Application Routes ---

// 1. Endpoint to RECEIVE webhooks from the game-server
app.post('/webhook', (req, res) => {
  const eventId = req.header('X-Event-Id') || `evt_${Date.now()}`;
  const signature = req.header('X-Signature');
  const isValid = verifySignature(req.body, signature);

  let parsedBody = {};
  try {
    parsedBody = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    console.error("Error parsing webhook body:", e);
    // Still log the raw body if parsing fails
  }

  const logEntry = {
    id: eventId,
    receivedAt: new Date().toISOString(),
    eventType: req.header('X-Event-Type'),
    sessionId: parsedBody.session_id || 'N/A',
    signature,
    isValid,
    payload: parsedBody,
  };

  // Store the log
  webhookLogs.set(logEntry.id, logEntry);
  console.log(`[INFO] Webhook Received: ${logEntry.eventType} for session ${logEntry.sessionId}. Valid: ${isValid}`);


  // Set a timer to auto-delete the log after 30 minutes (1800000 ms)
  setTimeout(() => {
    webhookLogs.delete(logEntry.id);
    console.log(`[INFO] Auto-deleted webhook log: ${logEntry.id}`);
  }, 1800000);


  res.status(200).json({ ok: true, signatureValid: isValid });
});

// 2. Endpoint for the FRONTEND to FETCH webhook logs
app.post('/api/webhooks', (req, res) => {
  const { password } = req.body;

  if (password !== process.env.VIEWER_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Convert Map iterator to an array and send
  const logs = Array.from(webhookLogs.values());
  res.json(logs);
});


// 3. Serve the Admin Control Panel UI
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.listen(PORT, () => {
  console.log(`Admin Control Panel listening on http://localhost:${PORT}`);
  if(!process.env.HMAC_SECRET) {
    console.warn('[WARN] HMAC_SECRET is not set. Webhook signature validation will fail.');
  }
    if(!process.env.VIEWER_PASSWORD) {
    console.warn('[WARN] VIEWER_PASSWORD is not set. The Admin UI will not be accessible.');
  }
});
