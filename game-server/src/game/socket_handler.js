const { addOrReconnectPlayer } = require('./session');

function initializeSocket(io) {
  io.on('connection', (socket) => {

    socket.on('join', async (data) => {
      try {
        if (!data || !data.session_id || !data.playerId || !data.playerName) {
          socket.emit('join-error', { message: 'Invalid payload. Must include session_id, playerId, and playerName.' });
          return;
        }

        const { session_id, playerId, playerName } = data;
        const result = await addOrReconnectPlayer(session_id, playerId, playerName, socket.id);

        if (!result.success) {
          socket.emit('join-error', { message: result.error });
          return;
        }

        socket.join(result.session.sessionId);

        if (result.isReconnect) {
            socket.emit('reconnected', { session_id: result.session.sessionId });
        }
        
        if (result.gameReady && !result.isReconnect) {
          const session = result.session;
          const gameFoundPayload = {
            session_id: session.sessionId,
            players: session.players.map(p => ({ playerId: p.playerId, playerName: p.playerName, symbol: p.symbol })),
            board: session.board,
            turn_duration_sec: session.turnDurationSec,
          };
          io.to(session.sessionId).emit('game-found', gameFoundPayload);
        }

      } catch (error) {
        console.error(`[Socket Handler] Error on join event:`, error);
        socket.emit('join-error', { message: 'An internal server error occurred.' });
      }
    });

    socket.on('disconnect', () => {
      // Disconnect/reconnect logic will be handled in a future checkpoint
    });
  });
}

module.exports = { initializeSocket };
