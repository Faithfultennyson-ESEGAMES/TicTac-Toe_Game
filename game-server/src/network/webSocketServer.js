const WebSocket = require('ws');
const logger = require('../utils/logger');
const { parse } = require('url');

const createWebSocketServer = ({ server, gameEngine, gameState, logEvent }) => {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    const { pathname } = parse(req.url);
    const match = pathname.match(/^\/connect\/([a-fA-F0-9-]+)$/);

    if (!match) {
      logger.warn('Invalid WebSocket connection attempt', { pathname });
      ws.close(1011, 'Invalid connection URL');
      return;
    }

    const sessionId = match[1];
    const session = gameState.getSession(sessionId);

    if (!session) {
      logger.warn('WebSocket connection for unknown session', { sessionId });
      ws.close(1011, 'Session not found');
      return;
    }
    
    logger.info('Player connected', { sessionId });
    ws.send(JSON.stringify({ type: 'connected', sessionId }));

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        logger.info('Received message', { sessionId, data });

        if (data.type === 'auth') {
          handleAuthentication(ws, sessionId, data.payload, { gameEngine, gameState, logEvent });
        }

        if (ws.isAuthenticated) {
          await handleMessage(ws, sessionId, data, { gameEngine, gameState });
        }
      } catch (error) {
        logger.error('Error processing message', { sessionId, error: error.message });
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      logger.info('Player disconnected', { sessionId, playerId: ws.playerId });
      if(ws.isAuthenticated){
        const player = session.players[ws.playerSymbol];
        gameState.setPlayerConnection(sessionId, ws.playerSymbol, false);
        logEvent(sessionId, 'player.disconnected', { playerId: ws.playerId });
      }
    });
  });

  return wss;
};

const handleAuthentication = (ws, sessionId, payload, { gameEngine, gameState, logEvent }) => {
  const { playerId } = payload;
  const session = gameState.getSession(sessionId);
  
  const playerEntry = Object.entries(session.players).find(([_, p]) => p.id === playerId);

  if (playerEntry) {
    const [playerSymbol, player] = playerEntry;

    if (player.connected) {
      ws.close(1008, 'Player already connected');
      return;
    }

    ws.isAuthenticated = true;
    ws.playerId = playerId;
    ws.playerSymbol = playerSymbol;
    
    gameState.setPlayerConnection(sessionId, playerSymbol, true, ws._socket.remoteAddress);

    logEvent(sessionId, 'player.joined', { playerId });

    ws.send(JSON.stringify({ type: 'authenticated', playerSymbol }));
    ws.send(JSON.stringify({ type: 'gameState', state: session }));

  } else {
    ws.close(1008, 'Player not found in session');
  }
};

const handleMessage = async (ws, sessionId, data, { gameEngine, gameState }) => {
  switch (data.type) {
    case 'move':
      const result = await gameEngine.handlePlayerMove({
        sessionId,
        playerId: ws.playerId,
        position: data.payload.position,
      });

      if (result.error) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
      } else {
        // The gameEngine will broadcast the new state
      }
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
};

module.exports = createWebSocketServer;
