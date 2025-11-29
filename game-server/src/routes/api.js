const express = require('express');
const { formatDuration, normalizePlayer } = require('../utils/helpers');
const logger = require('../utils/logger');

const createRouter = ({ gameState, matchmaker, gameEngine, config }) => {
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

  router.post('/start', (req, res) => {
    const { players, metadata } = req.body || {};

    if (!players || !players.X || !players.O) {
      return res.status(400).json({ error: 'players.X and players.O payloads are required' });
    }

    if (gameState.playerHasActiveSession(players.X.id) || gameState.playerHasActiveSession(players.O.id)) {
      return res.status(409).json({
        error: 'One or more players already assigned to an active session',
        player1Session: gameState.getPlayerSession(players.X.id),
        player2Session: gameState.getPlayerSession(players.O.id),
      });
    }

    const session = gameState.createSession({
      players: {
        X: {
          ...normalizePlayer(players.X),
          symbol: 'X',
          connected: false,
        },
        O: {
          ...normalizePlayer(players.O),
          symbol: 'O',
          connected: false,
        },
      },
      metadata: metadata || { source: 'api' },
    });

    gameEngine.startSession(session.sessionId);
    logger.info('Session created via API', {
      lifecycle: 'session-created',
      sessionId: session.sessionId,
    });

    const joinUrl = `${config.server.url.replace('http', 'ws')}/connect/${session.sessionId}`;

    return res.status(201).json({
      sessionId: session.sessionId,
      joinUrl: joinUrl,
      status: session.status,
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
