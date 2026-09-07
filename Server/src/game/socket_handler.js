require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const {
  addOrReconnectPlayer,
  setPlayerReady,
  setSessionEndNotifier,
  makeMove,
  relocateMove,
  handleDisconnect,
  passTurn,
  getSession,
  endSession,
} = require('./session');
const sessionLogger = require('../logging/session_logger');

const MAX_TURNS = parseInt(process.env.MAX_TURNS, 10) || 12;

function initializeSocket(io) {

  setSessionEndNotifier((session, payload) => {
    io.to(session.sessionId).emit('session-ended', payload);
  });

  const emitLobbyState = (session) => {
    io.to(session.sessionId).emit('lobby-state', {
      sessionId: session.sessionId,
      status: session.status,
      players: session.players.map(p => ({
        playerId: p.playerId,
        playerName: p.playerName,
        symbol: p.symbol,
        ready: Boolean(p.ready),
        connected: Boolean(p.socketId),
      })),
      expiresAt: session.expiresAt,
    });
  };

  const startTurn = async (session) => {
    if (!session || session.status !== 'active') {
      return;
    }

    clearTimeout(session.turnTimerId);

    if (session.turnCount >= MAX_TURNS) {
        const payload = await endSession(session.sessionId, 'draw', 'draw', null);
        if (payload) {
            io.to(session.sessionId).emit('move-applied', { board: payload.board, currentTurnPlayerId: null });
            io.to(session.sessionId).emit('game-ended', payload);
        }
        return;
    }

    const expiresAt = new Date(Date.now() + session.turnDurationSec * 1000);
    const expiresAtISO = expiresAt.toISOString();
    session.turnExpiresAt = expiresAtISO;

    sessionLogger.appendEvent(session.sessionId, 'turn.started', {
      playerId: session.currentTurnPlayerId,
      expiresAt: expiresAtISO,
    });

    io.to(session.sessionId).emit('turn-started', {
      currentTurnPlayerId: session.currentTurnPlayerId,
      expiresAt: expiresAtISO,
    });

    session.turnTimerId = setTimeout(async () => {
      const result = await passTurn(session.sessionId);
      if (result.success) {
          if (result.gameEnded) {
            io.to(session.sessionId).emit('move-applied', { board: result.payload.board, currentTurnPlayerId: null });
            io.to(session.sessionId).emit('game-ended', result.payload);
          } else {
            io.to(result.session.sessionId).emit('move-applied', { 
                board: result.session.board, 
                currentTurnPlayerId: result.nextTurnPlayerId 
            });
            startTurn(result.session);
          }
      }
    }, session.turnDurationSec * 1000);
  };

  io.on('connection', (socket) => {

    // Clock-sync: client sends its own timestamp, server acks back with its
    // own Date.now(). Client uses the round trip to compute a clockOffsetMs
    // so turn-timer countdowns aren't skewed by a wrong device clock.
    socket.on('time-sync', (clientSentAt, callback) => {
      if (typeof callback === 'function') callback(Date.now());
    });

    socket.on('join', async (data, ack) => {
      try {
        if (!data || !data.sessionId || !data.playerId || !data.playerName) {
          const error = { message: 'Invalid payload. Must include sessionId, playerId, and playerName.' };
          if (typeof ack === 'function') ack({ success: false, ...error });
          return socket.emit('join-error', error);
        }

        const { sessionId, playerId, playerName, reconnectToken = null } = data;
        const result = await addOrReconnectPlayer(sessionId, playerId, playerName, socket.id, reconnectToken);

        if (!result.success) {
          const error = { message: result.error };
          if (typeof ack === 'function') ack({ success: false, ...error });
          return socket.emit('join-error', error);
        }

        socket.join(sessionId);

        const { session } = result;

        if (result.isReconnect) {
            io.to(sessionId).emit('player-reconnected', { playerId });
        }
        
        emitLobbyState(session);
        if (result.gameReady) {
          io.to(sessionId).emit('game-found', {
            sessionId: session.sessionId,
            players: session.players.map(p => ({ playerId: p.playerId, playerName: p.playerName, symbol: p.symbol })),
            board: session.board,
            turnDurationSec: session.turnDurationSec,
            currentTurnPlayerId: session.currentTurnPlayerId,
            expiresAt: result.isReconnect ? session.turnExpiresAt : null,
          });
          if (!result.isReconnect) {
            startTurn(session);
          }
        } else if (session.status === 'pending' && session.players.length < 2) {
          io.to(sessionId).emit('waiting-for-player');
        }

        if (typeof ack === 'function') {
          ack({
            success: true,
            status: session.status,
            playerId,
            reconnectToken: result.reconnectToken || null,
          });
        }

      } catch (error) {
        console.error(`[Socket Handler] Error on join event:`, error);
        if (typeof ack === 'function') ack({ success: false, message: 'An internal server error occurred.' });
        socket.emit('join-error', { message: 'An internal server error occurred.' });
      }
    });

    socket.on('player-ready', async (data) => {
      try {
        if (!data || !data.sessionId) {
          return socket.emit('ready-error', { message: 'Invalid Ready payload.' });
        }
        const { sessionId } = data;
        const session = getSession(sessionId);
        const boundPlayer = session && session.players.find(p => p.socketId === socket.id);
        if (!boundPlayer) {
          return socket.emit('ready-error', { message: 'Player is not connected to this session.' });
        }
        if (data.playerId && data.playerId !== boundPlayer.playerId) {
          return socket.emit('ready-error', { message: 'Ready identity does not match this connection.' });
        }

        const playerId = boundPlayer.playerId;
        const result = await setPlayerReady(sessionId, playerId);
        if (!result.success) {
          return socket.emit('ready-error', { message: result.error });
        }

        socket.emit('ready-confirmed', { sessionId, playerId });
        emitLobbyState(result.session);

        if (result.bothReady && !result.alreadyActive) {
          io.to(sessionId).emit('game-found', {
            sessionId: result.session.sessionId,
            players: result.session.players.map(p => ({ playerId: p.playerId, playerName: p.playerName, symbol: p.symbol })),
            board: result.session.board,
            turnDurationSec: result.session.turnDurationSec,
            currentTurnPlayerId: result.session.currentTurnPlayerId,
          });
          startTurn(result.session);
        }
      } catch (error) {
        console.error(`[Socket Handler] Error on player-ready event:`, error);
        socket.emit('ready-error', { message: 'An internal server error occurred.' });
      }
    });

    socket.on('make-move', async(data) => {
        try {
            if (!data || !data.sessionId || data.position === undefined) {
                return socket.emit('move-error', { message: 'Invalid move payload.' });
            }
            const { sessionId, position } = data;
            const session = getSession(sessionId);
            const boundPlayer = session && session.players.find(p => p.socketId === socket.id);
            if (!boundPlayer) {
                return socket.emit('move-error', { message: 'Player is not connected to this session.' });
            }
            if (data.playerId && data.playerId !== boundPlayer.playerId) {
                return socket.emit('move-error', { message: 'Move identity does not match this connection.' });
            }
            const playerId = boundPlayer.playerId;
            
            const result = await makeMove(sessionId, playerId, position);

            if (!result.success) {
                return socket.emit('move-error', { message: result.error });
            }

            if (result.gameEnded) {
                io.to(sessionId).emit('move-applied', { board: result.payload.board, currentTurnPlayerId: null });
                io.to(sessionId).emit('game-ended', result.payload);
            } else {
                io.to(sessionId).emit('move-applied', { 
                    board: result.board, 
                    currentTurnPlayerId: result.nextTurnPlayerId 
                });
                const session = getSession(sessionId);
                startTurn(session);
            }
        } catch (error) {
            console.error(`[Socket Handler] Error on make-move event:`, error);
            socket.emit('move-error', { message: 'An internal server error occurred.' });
        }
    });
    
    socket.on('relocate-move', async(data) => {
        try {
            if (!data || !data.sessionId || data.from === undefined || data.to === undefined) {
                return socket.emit('move-error', { message: 'Invalid relocate payload.' });
            }
            const { sessionId, from, to } = data;
            const session = getSession(sessionId);
            const boundPlayer = session && session.players.find(p => p.socketId === socket.id);
            if (!boundPlayer) {
                return socket.emit('move-error', { message: 'Player is not connected to this session.' });
            }
            if (data.playerId && data.playerId !== boundPlayer.playerId) {
                return socket.emit('move-error', { message: 'Move identity does not match this connection.' });
            }
            const playerId = boundPlayer.playerId;
            
            const result = await relocateMove(sessionId, playerId, from, to);

            if (!result.success) {
                return socket.emit('move-error', { message: result.error });
            }

            if (result.gameEnded) {
                io.to(sessionId).emit('move-applied', { board: result.payload.board, currentTurnPlayerId: null });
                io.to(sessionId).emit('game-ended', result.payload);
            } else {
                io.to(sessionId).emit('move-applied', { 
                    board: result.board, 
                    currentTurnPlayerId: result.nextTurnPlayerId 
                });
                const session = getSession(sessionId);
                startTurn(session);
            }
        } catch (error) {
            console.error(`[Socket Handler] Error on relocate-move event:`, error);
            socket.emit('move-error', { message: 'An internal server error occurred.' });
        }
    });

    socket.on('disconnect', async () => {
        try {
            const result = await handleDisconnect(socket.id);
            if (!result) return;

            if (result.session.status === 'active') {
                io.to(result.session.sessionId).emit('player-disconnected', {
                    playerId: result.disconnectedPlayerId,
                });
            } else if (result.session.status === 'pending') {
                // Keep the remaining lobby participant in sync. Pending Ready
                // is reset on disconnect, so clients must immediately see the
                // updated connected/Ready state rather than a stale 2/2 lobby.
                emitLobbyState(result.session);
            }
        } catch(error) {
            console.error(`[Socket Handler] Error on disconnect event:`, error);
        }
    });
  });
}

module.exports = { initializeSocket };
