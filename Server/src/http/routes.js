const express = require('express');
const crypto = require('crypto');
const { createSession, getSession } = require('../game/session');
const { dispatchEvent } = require('../webhooks/dispatcher');
const sessionLogger = require('../logging/session_logger');
const { startRequestAuth } = require('./middleware/auth');

const router = express.Router();
const HMAC_SECRET = process.env.HMAC_SECRET;

router.get('/session/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session || session.status === 'ended') {
    return res.status(404).json({ error: 'Session not found or ended.' });
  }

  res.json({
    sessionId: session.sessionId,
    status: session.status,
    players: session.players.map(p => ({
      playerId: p.playerId,
      playerName: p.playerName,
      symbol: p.symbol,
      ready: Boolean(p.ready),
      connected: Boolean(p.socketId),
    })),
    board: session.board,
    turnDurationSec: session.turnDurationSec,
    currentTurnPlayerId: session.currentTurnPlayerId,
    turnExpiresAt: session.turnExpiresAt || null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  });
});

router.post('/start', startRequestAuth, async (req, res) => {
  if (!HMAC_SECRET) {
    console.error('[Auth] HMAC_SECRET is not configured. Cannot sign responses.');
    return res.status(500).json({ error: 'Server security is not configured.' });
  }

  let { turnDurationSec } = req.body;

  if (turnDurationSec !== undefined) {
    turnDurationSec = parseInt(turnDurationSec, 10);
    if (isNaN(turnDurationSec) || turnDurationSec <= 0) {
      return res.status(400).json({ error: 'Invalid turnDurationSec. Must be a positive integer.' });
    }
  }

  const session = createSession(turnDurationSec);

  sessionLogger.startSessionLog(session);

  await dispatchEvent('session.created', session, session.sessionId);

  const publicHost = String(req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();
  const joinUrl = `${req.protocol}://${publicHost}/session/${session.sessionId}/join`;

  const payload = {
    sessionId: session.sessionId,
    joinUrl: joinUrl,
  };

  // Sign the payload
  const signature = crypto.createHmac('sha256', HMAC_SECRET).update(JSON.stringify(payload)).digest('hex');

  res.set('X-Hub-Signature-256', signature);
  res.status(201).json(payload);
});

module.exports = router;
