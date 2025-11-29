const express = require('express');
const { formatDuration, normalizePlayer } = require('../utils/helpers');
const logger = require('../utils/logger');

const createRouter = ({ gameState, matchmaker, gameEngine }) => {
  const router = express.Router();
  const SESSION_STATUSES = gameState.constructor.STATUSES;

  router.get('/status', (req, res) => {
    const stats = gameState.getSessionStats();

    res.json({
      status: 'running',
      activeGames: stats.counts[SESSION_STATUSES.ACTIVE],
      pendingDisconnect: stats.counts[SESSION_STATUSES.DISCONNECT_PENDING],
      awaitingStart: stats.counts[SESSION_STATUSES.CREATED],
      completed: stats.counts[SESSION_STATUSES.COMPLETED],
      totalSessions: stats.total,
      playersInQueue: matchmaker.getQueueSize(),
      uptime: formatDuration(process.uptime()),
    });
  });

  router.post('/create-session', (req, res) => {
    const { player1, player2 } = req.body || {};

    if (!player1 || !player2) {
      return res.status(400).json({ error: 'player1 and player2 payloads are required' });
    }

    if (gameState.playerHasActiveSession(player1.id) || gameState.playerHasActiveSession(player2.id)) {
      return res.status(409).json({
        error: 'One or more players already assigned to an active session',
        player1Session: gameState.getPlayerSession(player1.id),
        player2Session: gameState.getPlayerSession(player2.id),
      });
    }

    const session = gameState.createSession({
      players: {
        X: {
          ...normalizePlayer(player1),
          symbol: 'X',
          connected: true,
        },
        O: {
          ...normalizePlayer(player2),
          symbol: 'O',
          connected: true,
        },
      },
      metadata: {
        source: 'manual-api',
      },
    });

    const started = gameEngine.startSession(session.sessionId);
    logger.info('Manual session created', {
      lifecycle: 'session-created',
      sessionId: session.sessionId,
    });

    return res.status(201).json({
      sessionId: session.sessionId,
      gameState: started,
    });
  });

  router.get('/session/:sessionId', (req, res) => {
    const session = gameState.getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    return res.json(session);
  });

  return router;
};

module.exports = createRouter;
