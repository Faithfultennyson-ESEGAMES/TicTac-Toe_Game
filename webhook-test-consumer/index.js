const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = 4000;

// We need the RAW body (Buffer) to verify HMAC correctly.
// So: use express.raw instead of express.json.
app.use(
  '/webhook',
  express.raw({ type: 'application/json' })
);

// Simple middleware to log every request briefly
app.use((req, res, next) => {
  console.log('--- Incoming Request ---');
  console.log(req.method, req.url);
  next();
});

// Helper: verify HMAC-SHA256 signature
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    console.warn('[WARN] HMAC_SECRET is not set in .env — cannot verify signature.');
    return false;
  }

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  // Dispatcher format: "sha256=<hex>"
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) {
    return false;
  }

  const received = signatureHeader.trim();
  const computedHex = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const expected = `${expectedPrefix}${computedHex}`;

  // Timing-safe comparison when possible
  const receivedBuf = Buffer.from(received, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(receivedBuf, expectedBuf);
  } catch {
    // Fallback if something weird happens
    return false;
  }
}

// Main webhook endpoint
app.post('/webhook', (req, res) => {
  const eventId = req.header('X-Event-Id');
  const eventType = req.header('X-Event-Type');
  const signature = req.header('X-Signature');

  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from('', 'utf8');

  // Try to parse JSON for pretty logging
  let parsedBody = null;
  try {
    parsedBody = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    parsedBody = null;
  }

  const isValid = verifySignature(rawBody, signature);

  console.log('=== Webhook Received ===');
  console.log('Time:        ', new Date().toISOString());
  console.log('Event ID:    ', eventId);
  console.log('Event Type:  ', eventType);
  console.log('Signature:   ', signature);
  console.log('Signature OK:', isValid);
  console.log('Body:');
  console.dir(parsedBody ?? rawBody.toString('utf8'), { depth: null });
  console.log('=========================');
  console.log('');

  // We still reply 200 so the dispatcher treats this as success.
  // If you ever want to test failure paths, you could conditionally send 400 when !isValid.
  res.status(200).json({ ok: true, signatureValid: isValid });
});

// Optional: a tiny GET endpoint just to see if server is alive
app.get('/', (req, res) => {
  res.send('Webhook Test Consumer is running ✅');
});

app.listen(PORT, () => {
  console.log(`Webhook Test Consumer listening on port ${PORT}`);
});
