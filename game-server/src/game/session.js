const crypto = require('crypto');
const { signPayload } = require('../utils/security');

const sessions = new Map();

function createSession(turnDurationSec = 10) {
  const sessionId = crypto.randomUUID();
  const session = {
    sessionId,
    status: 'pending',
    players: [],
    board: Array(9).fill(null),
    turnDurationSec,
    createdAt: new Date().toISOString(),
  };
  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

module.exports = { createSession, getSession };
