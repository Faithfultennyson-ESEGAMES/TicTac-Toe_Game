process.env.WEBHOOK_ENDPOINTS = '';
process.env.MATCHMAKING_SERVICE_URL = '';
process.env.HMAC_SECRET = 'prestart-test-secret';
process.env.SESSION_MAX_LIFETIME_MS = '0';

const assert = require('assert');
const sessionManager = require('./src/game/session');

(async () => {
  const session = sessionManager.createSession(10);

  assert.equal(session.status, 'pending');
  assert.equal(session.startedAt, null);
  assert.equal(session.expiresAt, null);

  const result = await sessionManager.endSession(
    session.sessionId,
    'admin_forced_end',
    'draw',
    'should-never-survive'
  );

  assert(result, 'endSession should return a client payload');
  assert.equal(session.status, 'ended');
  assert.equal(session.startedAt, null);
  assert.equal(session.winState, 'none');
  assert.equal(session.winnerPlayerId, null);
  assert.equal(sessionManager.getSession(session.sessionId), undefined);

  console.log('PRESTART_SETTLEMENT=PASS');
})().catch((error) => {
  console.error('PRESTART_SETTLEMENT=FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
