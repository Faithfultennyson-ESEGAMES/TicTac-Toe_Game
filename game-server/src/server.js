require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const gameConfig = require('./config/gameConfig');
const logger = require('./utils/logger');
const GameStateStore = require('./game/gameState');
const TimerManager = require('./game/timers');
const GameEngine = require('./game/gameEngine');
const MatchQueue = require('./matchmaking/queue');
const Matchmaker = require('./matchmaking/matchmaker');
const createApiRouter = require('./routes/api');
const validation = require('./game/validation');

const SESSION_STATUSES = GameStateStore.STATUSES;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

io.engine.on('connection_error', (err) => {
  logger.warn('Socket.IO handshake failed', {
    code: err.code,
    message: err.message,
    context: err.context,
  });
});
const gameState = new GameStateStore();
const timers = new TimerManager();
const matchQueue = new MatchQueue();
const matchmaker = new Matchmaker({ queue: matchQueue, gameState });
const gameEngine = new GameEngine({ gameState, timers });

app.use('/api', createApiRouter({ gameState, matchmaker, gameEngine }));

app.get('/', (req, res) => {
  res.json({
    message: 'Tic-Tac-Toe Game Server running',
    phase: gameConfig.metadata.version,
  });
});

const socketRoomName = (sessionId) => `session:${sessionId}`;

matchmaker.on('match-found', (session) => {
  const startedSession = gameEngine.startSession(session.sessionId);

  ['X', 'O'].forEach((symbol) => {
    const player = startedSession.players[symbol];
    if (!player?.socketId) {
      return;
    }

    const playerSocket = io.sockets.sockets.get(player.socketId);
    if (!playerSocket) {
      return;
    }

    playerSocket.data.sessionId = startedSession.sessionId;
    playerSocket.data.playerSymbol = symbol;
    playerSocket.join(socketRoomName(startedSession.sessionId));
    gameState.setPlayerConnection(startedSession.sessionId, symbol, true);

    playerSocket.emit('game-found', {
      sessionId: startedSession.sessionId,
      symbol,
      state: startedSession,
    });
  });

  io.to(socketRoomName(startedSession.sessionId)).emit('turn-started', {
    sessionId: startedSession.sessionId,
    currentTurn: startedSession.currentTurn,
    turnExpiresAt: startedSession.turnExpiresAt,
  });
});

io.on('connection', (socket) => {
  logger.info('Socket connected', { socketId: socket.id });

  socket.on('register-player', (payload = {}, callback = () => {}) => {
    const playerId = payload.id || socket.id;
    socket.data.player = {
      id: playerId,
      name: payload.name || 'Player',
      stake: payload.stake || 0,
    };

    callback({ acknowledged: true, playerId });
  });

  socket.on('join-queue', (payload = {}, callback = () => {}) => {
    const basePlayer = socket.data.player || { id: socket.id, name: 'Player', stake: 0 };
    const requestPlayer = {
      ...basePlayer,
      ...payload,
      id: payload.id || basePlayer.id,
      socketId: socket.id,
    };

    const existingSession = gameState.getPlayerSession(requestPlayer.id);
    if (existingSession && existingSession.status !== SESSION_STATUSES.COMPLETED) {
      return callback({
        status: 'in-session',
        session: existingSession,
        message: 'Player already assigned to session',
      });
    }

    const result = matchmaker.addPlayerToQueue(requestPlayer);
    callback(result);
  });

  socket.on('cancel-queue', (callback = () => {}) => {
    const playerId = socket.data.player?.id;
    if (!playerId) {
      return callback({ cancelled: false, reason: 'not_registered' });
    }

    const cancelled = matchmaker.removePlayer(playerId);
    callback({ cancelled });
  });

  socket.on('make-move', async (payload = {}, callback = () => {}) => {
    try {
      const { sessionId, position } = payload;
      const playerId = socket.data.player?.id;
      if (!sessionId || typeof position !== 'number') {
        return callback({ error: 'invalid_payload' });
      }

      const moveResult = await gameEngine.handlePlayerMove({ sessionId, playerId, position });
      if (moveResult.error) {
        return callback({ error: moveResult.error });
      }

      io.to(socketRoomName(sessionId)).emit('move-applied', {
        sessionId,
        board: moveResult.session.board,
        moves: moveResult.session.moves,
        currentTurn: moveResult.session.currentTurn,
        turnExpiresAt: moveResult.session.turnExpiresAt,
      });

      if (moveResult.status === 'completed') {
        io.to(socketRoomName(sessionId)).emit('game-ended', {
          sessionId,
          result: moveResult.session.result,
          finalState: moveResult.session,
        });
      }

      return callback({ ok: true });
    } catch (error) {
      logger.error('Move handling failed', { error: error.message });
      return callback({ error: 'internal_error' });
    }
  });

  socket.on('forfeit', async (payload = {}, callback = () => {}) => {
    const { sessionId } = payload;
    const playerSymbol = socket.data.playerSymbol;
    if (!sessionId || !playerSymbol) {
      return callback({ error: 'invalid_payload' });
    }

    const result = await gameEngine.forfeitSession(sessionId, playerSymbol, 'voluntary_forfeit');
    if (result) {
      io.to(socketRoomName(sessionId)).emit('game-ended', {
        sessionId,
        result: result.result,
        finalState: result,
      });
      callback({ ok: true });
    } else {
      callback({ error: 'session_not_found' });
    }
  });

  socket.on('rejoin-session', (payload = {}, callback = () => {}) => {
    const { sessionId, playerId } = payload;
    if (!sessionId || !playerId) {
      return callback({ error: 'invalid_payload' });
    }

    const session = gameState.getSession(sessionId);
    if (!session) {
      return callback({ error: 'session_not_found' });
    }

    const symbol = validation.getPlayerSymbolById(session, playerId);
    if (!symbol) {
      return callback({ error: 'player_not_in_session' });
    }

    socket.data.player = {
      id: playerId,
      name: session.players[symbol].name,
      stake: session.players[symbol].stake,
    };
    socket.data.sessionId = sessionId;
    socket.data.playerSymbol = symbol;

    timers.clearDisconnectTimer(sessionId, playerId);
    gameState.setPlayerConnection(sessionId, symbol, true);
    gameState.setStatus(sessionId, SESSION_STATUSES.ACTIVE);

    logger.info('Session lifecycle transition', {
      lifecycle: 'session-active',
      reason: 'player-rejoined',
      sessionId,
      playerId,
    });

    socket.join(socketRoomName(sessionId));

    callback({ ok: true, symbol });

    io.to(socketRoomName(sessionId)).emit('player-rejoined', {
      sessionId,
      playerId,
      symbol,
    });
  });

  socket.on('disconnect', () => {
    const playerId = socket.data.player?.id;
    const sessionId = socket.data.sessionId;
    const symbol = socket.data.playerSymbol;

    logger.info('Socket disconnected', { socketId: socket.id, playerId });

    if (playerId) {
      matchmaker.removePlayer(playerId);
    }

    if (sessionId && symbol) {
      const session = gameState.getSession(sessionId);
      if (session && session.status !== SESSION_STATUSES.COMPLETED) {
        gameState.setPlayerConnection(sessionId, symbol, false);
        if (session.status !== SESSION_STATUSES.DISCONNECT_PENDING) {
          gameState.setStatus(sessionId, SESSION_STATUSES.DISCONNECT_PENDING);
          logger.warn('Session lifecycle transition', {
            lifecycle: 'session-disconnect-pending',
            sessionId,
            playerId,
            symbol,
          });
        }

        const disconnectExpiresAt = timers.startDisconnectTimer(sessionId, playerId, async () => {
          const result = await gameEngine.forfeitSession(sessionId, symbol, 'disconnect_timeout');
          if (result) {
            io.to(socketRoomName(sessionId)).emit('game-ended', {
              sessionId,
              result: result.result,
              finalState: result,
            });
          }
        });

        io.to(socketRoomName(sessionId)).emit('player-disconnected', {
          sessionId,
          playerId,
          symbol,
          disconnectExpiresAt,
        });
      }
    }
  });
});

const start = () => {
  server.listen(gameConfig.server.port, () => {
    logger.info('Game server listening', {
      port: gameConfig.server.port,
      environment: gameConfig.server.env,
    });
  });
};

if (require.main === module) {
  start();
}

module.exports = {
  start,
  app,
  io,
};

