# Webhook Integration Guide

## Overview

The Tic-Tac-Toe Game Server dispatches real-time events to webhook endpoints configured by the application. This guide explains how to build and configure an endpoint to receive and validate these webhooks.

---

## What Your Endpoint Will Receive

### Request Format

All webhook requests are **HTTP POST** requests with the following characteristics:

- **Content-Type**: `application/json`
- **Method**: `POST`
- **Timeout**: 5 seconds (5000ms)

### Request Headers

Every webhook request includes three critical headers:

| Header | Description | Example |
|--------|-------------|---------|
| `X-Event-Id` | Unique identifier for this event | `550e8400-e29b-41d4-a716-446655440000` |
| `X-Event-Type` | Type of event being dispatched | `session.started`, `player.joined`, `player.turn_passed` |
| `X-Signature` | HMAC-SHA256 signature for payload verification | `sha256=a1b2c3d4e5f6...` |

### Request Body

The request body is a JSON object with the following structure:

```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "event_type": "session.started",
  "session_id": "session-123",
  "body": {
    // Event-specific payload (varies by event type)
  }
}
```

---

## Event Types

The game server emits the following event types:

### 1. `session.started`
Fired when a new game session is created.

**Payload:**
```json
{
  "body": {
    "sessionId": "session-123",
    "players": [],
    "gameState": "waiting_for_players",
    "createdAt": "2025-12-05T10:30:00.000Z"
  }
}
```

### 2. `session.ended`
Fired when a game session concludes.

**Payload:**
```json
{
  "body": {
    "sessionId": "session-123",
    "winner": "player-1",
    "endedAt": "2025-12-05T10:45:00.000Z"
  }
}
```

### 3. `player.joined`
Fired when a player joins a session.

**Payload:**
```json
{
  "body": {
    "player_id": "player-1",
    "player_name": "Alice",
    "status": "joined"
  }
}
```

### 4. `player.reconnected`
Fired when a player reconnects after disconnection.

**Payload:**
```json
{
  "body": {
    "player_id": "player-1",
    "status": "reconnected"
  }
}
```

### 5. `player.disconnected`
Fired when a player disconnects from a session.

**Payload:**
```json
{
  "body": {
    "player_id": "player-1",
    "status": "disconnected"
  }
}
```

### 6. `player.turn_passed`
Fired when a player's turn times out or is skipped.

**Payload:**
```json
{
  "body": {
    "player_id": "player-1",
    "reason": "timeout"
  }
}
```

---

## HMAC Signature Verification

### Why Verify Signatures?

Signature verification ensures that:
1. The webhook originated from the game server (authentication)
2. The payload has not been modified in transit (integrity)

### How Signatures Are Generated

The game server creates HMAC-SHA256 signatures as follows:

```
1. Serialize the payload to JSON string
2. Compute HMAC-SHA256 using the shared secret key and JSON string
3. Format as: sha256=<hex-encoded-hmac>
4. Send in X-Signature header
```

### How to Verify Signatures

#### Step 1: Extract the Signature
Retrieve the `X-Signature` header from the request.

#### Step 2: Get the Raw Body
**IMPORTANT**: Use the **raw request body as bytes**, not the parsed JSON object. This is critical because JSON serialization can vary (whitespace, key ordering, etc.).

#### Step 3: Compute the HMAC
Using your shared secret, compute an HMAC-SHA256 of the raw body.

#### Step 4: Compare
Compare your computed HMAC with the one sent by the server using **timing-safe comparison** to prevent timing attacks.

---

## Implementation Examples

### Node.js / Express

```javascript
const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = 4000;

// CRITICAL: Use express.raw() to get the raw body as a Buffer
// Do NOT use express.json() directly, as it loses byte-level accuracy
app.use(
  '/webhook',
  express.raw({ type: 'application/json' })
);

// Verify HMAC-SHA256 signature
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.HMAC_SECRET;
  
  if (!secret) {
    console.error('HMAC_SECRET not configured');
    return false;
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  // Extract the hex portion
  const receivedHex = signatureHeader.slice(7); // Remove "sha256=" prefix

  // Compute expected HMAC
  const computedHex = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Timing-safe comparison
  const receivedBuf = Buffer.from(receivedHex, 'utf8');
  const expectedBuf = Buffer.from(computedHex, 'utf8');

  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(receivedBuf, expectedBuf);
  } catch {
    return false;
  }
}

// Webhook endpoint
app.post('/webhook', (req, res) => {
  const eventId = req.header('X-Event-Id');
  const eventType = req.header('X-Event-Type');
  const signature = req.header('X-Signature');
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from('', 'utf8');

  // Verify signature
  const isValid = verifySignature(rawBody, signature);

  if (!isValid) {
    console.warn(`[WARN] Invalid signature for event ${eventId}`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse JSON for use
  let payload = null;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Process event
  console.log(`[${eventType}] ${eventId}`);
  console.log(`Session: ${payload.session_id}`);
  console.log(`Data:`, payload.body);

  // Respond with 200 OK
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Webhook consumer listening on port ${PORT}`);
});
```

**Environment Setup (.env):**
```dotenv
HMAC_SECRET=your-shared-secret-key-here
```

### Python / Flask

```python
import os
import hmac
import hashlib
import json
from flask import Flask, request

app = Flask(__name__)
PORT = 4000

def verify_signature(raw_body, signature_header):
    """Verify HMAC-SHA256 signature"""
    secret = os.getenv('HMAC_SECRET')
    
    if not secret or not signature_header or not signature_header.startswith('sha256='):
        return False
    
    # Extract hex from "sha256=<hex>"
    received_hex = signature_header[7:]
    
    # Compute expected HMAC
    computed_hex = hmac.new(
        secret.encode(),
        raw_body,
        hashlib.sha256
    ).hexdigest()
    
    # Timing-safe comparison
    return hmac.compare_digest(received_hex, computed_hex)

@app.route('/webhook', methods=['POST'])
def webhook():
    event_id = request.headers.get('X-Event-Id')
    event_type = request.headers.get('X-Event-Type')
    signature = request.headers.get('X-Signature')
    raw_body = request.get_data()
    
    # Verify signature
    if not verify_signature(raw_body, signature):
        print(f"[WARN] Invalid signature for event {event_id}")
        return {'error': 'Invalid signature'}, 401
    
    # Parse JSON
    try:
        payload = json.loads(raw_body)
    except:
        return {'error': 'Invalid JSON'}, 400
    
    # Process event
    print(f"[{event_type}] {event_id}")
    print(f"Session: {payload['session_id']}")
    print(f"Data: {payload['body']}")
    
    return {'ok': True}, 200

if __name__ == '__main__':
    app.run(port=PORT)
```

**Environment Setup (.env):**
```
HMAC_SECRET=your-shared-secret-key-here
```

### PHP

```php
<?php
require 'vendor/autoload.php';
use Dotenv\Dotenv;

// Load environment variables
$dotenv = Dotenv::createImmutable(__DIR__);
$dotenv->load();

function verifySignature($rawBody, $signatureHeader) {
    $secret = $_ENV['HMAC_SECRET'] ?? null;
    
    if (!$secret || !str_starts_with($signatureHeader, 'sha256=')) {
        return false;
    }
    
    // Extract hex from "sha256=<hex>"
    $receivedHex = substr($signatureHeader, 7);
    
    // Compute expected HMAC
    $computedHex = hash_hmac('sha256', $rawBody, $secret);
    
    // Timing-safe comparison
    return hash_equals($receivedHex, $computedHex);
}

// Get raw POST body
$rawBody = file_get_contents('php://input');
$eventId = $_SERVER['HTTP_X_EVENT_ID'] ?? null;
$eventType = $_SERVER['HTTP_X_EVENT_TYPE'] ?? null;
$signature = $_SERVER['HTTP_X_SIGNATURE'] ?? null;

// Verify signature
if (!verifySignature($rawBody, $signature)) {
    http_response_code(401);
    echo json_encode(['error' => 'Invalid signature']);
    exit;
}

// Parse JSON
$payload = json_decode($rawBody, true);
if (!$payload) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid JSON']);
    exit;
}

// Process event
error_log("[{$eventType}] {$eventId}");
error_log("Session: {$payload['session_id']}");
error_log("Data: " . json_encode($payload['body']));

http_response_code(200);
echo json_encode(['ok' => true]);
```

---

## Configuration on Game Server

To enable webhook delivery, configure the game server's `.env` file:

```dotenv
# Webhook endpoints (comma-separated)
WEBHOOK_ENDPOINTS="http://localhost:4000/webhook,http://your-service.com/webhook"

# Shared secret for HMAC signature
HMAC_SECRET=your-shared-secret-key-here

# Retry configuration
MAX_WEBHOOK_ATTEMPTS=5
RETRY_SCHEDULE_MS="5000,15000,30000,60000"
```

### Retry Behavior

If a webhook fails:
1. **Attempt 1**: Immediate
2. **Attempt 2**: After 5 seconds
3. **Attempt 3**: After 15 seconds
4. **Attempt 4**: After 30 seconds
5. **Attempt 5**: After 60 seconds

After all retries are exhausted, the event is moved to the **Dead Letter Queue (DLQ)** for manual review.

---

## Error Handling

### Expected Response

Your endpoint should respond with:

```json
HTTP 200 OK
Content-Type: application/json

{
  "ok": true
}
```

### What Triggers Retries?

- **5xx responses** (Server errors)
- **Network errors** (Timeout, connection refused, etc.)

### What Does NOT Trigger Retries?

- **2xx responses** (Success)
- **4xx responses** (Client errors like 400, 401, 404)

### Testing Failure Cases

If you want to test retry behavior, you can temporarily return a 5xx status:

```javascript
if (someTestCondition) {
  return res.status(500).json({ error: 'Simulated failure' });
}
```

---

## Dead Letter Queue (DLQ)

If an event fails after all retry attempts, it's stored in the game server's DLQ for manual inspection and replay.

**DLQ Item Structure:**
```json
{
  "dlq_item_id": "550e8400-e29b-41d4-a716-446655440000",
  "failed_at": "2025-12-05T10:30:00.000Z",
  "reason": "Exhausted 5 retry attempts.",
  "endpoint": "http://your-service.com/webhook",
  "last_response_status": 500,
  "delivery_attempts": [
    {
      "attempt_id": "550e8400-e29b-41d4-a716-446655440001",
      "timestamp": "2025-12-05T10:30:00.000Z",
      "status_code": 500,
      "error": "Internal Server Error"
    }
  ],
  "webhook_payload": { /* Original event */ }
}
```

The game server admin can replay these events via the admin API (`GET /admin/dlq`).

---

## Best Practices

1. **Always verify signatures** — Never skip signature validation, even in development.
2. **Use raw bodies** — Ensure you access the raw request body (bytes), not parsed JSON.
3. **Implement idempotency** — Handle duplicate events gracefully (same `event_id`).
4. **Return 200 quickly** — Process events asynchronously; don't block the webhook response.
5. **Log everything** — Log event ID, type, and processing outcome for debugging.
6. **Set a timeout** — Expect webhooks within 5 seconds; log and alert if they're delayed.
7. **Monitor 4xx errors** — These are permanent failures and indicate configuration issues.
8. **Secure your endpoint** — Use HTTPS in production, not HTTP.

---

## Troubleshooting

### Signature Verification Fails

**Common Causes:**
- Using parsed JSON instead of raw body
- Secret key mismatch
- Different JSON serialization (whitespace, key order)

**Solution:**
- Always use the raw body bytes
- Verify the `HMAC_SECRET` matches between server and consumer
- Use timing-safe comparison functions

### Webhooks Not Arriving

**Common Causes:**
- Endpoint URL is wrong
- Firewall/network blocking
- Endpoint returning 4xx errors

**Solution:**
- Check game server logs for error messages
- Verify endpoint URL is reachable
- Check your endpoint's error logs
- Use the Dead Letter Queue to inspect failed deliveries

### Endpoint Crashes on Webhook

**Common Causes:**
- Unexpected payload structure
- Parsing errors

**Solution:**
- Add defensive parsing with try-catch
- Log raw body for debugging
- Gracefully handle missing fields in payload

---

## Support

For issues or questions:
1. Check the Dead Letter Queue for failed events
2. Review game server logs (typically in `game-server/logs/`)
3. Inspect webhook test consumer example at `webhook-test-consumer/index.js`

