const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

(async () => {
  const secret = 'ttt-webhook-contract-test-secret';
  const received = [];
  const waiters = [];

  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      received.push({
        rawBody,
        eventId: req.headers['x-event-id'],
        eventType: req.headers['x-event-type'],
        signature: req.headers['x-hub-signature-256'],
        contentType: req.headers['content-type'],
      });
      while (waiters.length) waiters.shift()();
      res.statusCode = 204;
      res.end();
    });
  });

  await new Promise((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen(0, '127.0.0.1', resolve);
  });

  const port = receiver.address().port;
  const endpoint = `http://127.0.0.1:${port}/webhook`;
  process.env.HMAC_SECRET = secret;
  process.env.WEBHOOK_ENDPOINTS = endpoint;
  process.env.MATCHMAKING_SERVICE_URL = endpoint;
  process.env.MAX_WEBHOOK_ATTEMPTS = '2';
  process.env.RETRY_SCHEDULE_MS = '50';

  const dispatcher = require('./src/webhooks/dispatcher');
  const { notifySessionClosed } = require('./src/webhooks/matchmaking_notifier');
  await dispatcher.init();

  const payload = {
    sessionId: 'contract-test-session',
    status: 'ended',
    startedAt: null,
    winState: 'none',
    winnerPlayerId: null,
  };
  const expectedBody = JSON.stringify(payload);

  const waitForCount = async (count, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (received.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${count} webhook(s)`);
      await Promise.race([
        new Promise((resolve) => waiters.push(resolve)),
        new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 100))),
      ]);
    }
  };

  dispatcher.dispatchEvent('session.ended', payload, payload.sessionId);
  await waitForCount(1);
  await notifySessionClosed(payload);
  await waitForCount(2);

  const byType = new Map(received.map((item) => [item.eventType, item]));
  for (const type of ['session.ended', 'session.closed']) {
    const item = byType.get(type);
    assert(item, `${type} was not delivered`);
    assert.equal(item.rawBody, expectedBody, `${type} body must be the direct final session JSON`);
    assert(item.eventId, `${type} is missing X-Event-Id`);
    assert.match(item.contentType || '', /^application\/json/i, `${type} content type is not JSON`);
    const expectedSignature = crypto.createHmac('sha256', secret).update(item.rawBody).digest('hex');
    assert.equal(item.signature, expectedSignature, `${type} HMAC signature is invalid`);
  }

  assert.notEqual(
    byType.get('session.ended').eventId,
    byType.get('session.closed').eventId,
    'session.ended and session.closed must have independent event IDs'
  );

  console.log('WEBHOOK_CONTRACT=PASS');
  receiver.close();
})().catch((error) => {
  console.error('WEBHOOK_CONTRACT=FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
