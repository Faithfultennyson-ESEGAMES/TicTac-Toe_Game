const crypto = require('crypto');
const { dispatchEvent } = require('../webhooks/dispatcher');

const sessions = new Map();
const activePlayerIds = new Map(); // playerId -> sessionId

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

/**
 * Adds a player to a session or reconnects them.
 * @returns {{success: boolean, error?: string, isReconnect: boolean, gameReady: boolean, session: object}}
 */
async function addOrReconnectPlayer(sessionId, playerId, playerName, socketId) {
  const session = getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found.' };
  }

  // Prevent player from joining multiple different sessions
  if (activePlayerIds.has(playerId) && activePlayerIds.get(playerId) !== sessionId) {
    return { success: false, error: 'Player already in another session.' };
  }

  const existingPlayer = session.players.find(p => p.playerId === playerId);

  if (existingPlayer) {
    // --- Player is reconnecting ---
    existingPlayer.socketId = socketId;
    return { success: true, isReconnect: true, gameReady: session.status === 'active', session };

  } else {
    // --- New player is joining ---
    if (session.players.length >= 2) {
      return { success: false, error: 'Session is full.' };
    }

    const player = {
      playerId,
      playerName,
      socketId,
      symbol: session.players.length === 0 ? 'X' : 'O',
    };
    session.players.push(player);
    activePlayerIds.set(playerId, sessionId);

    // Dispatch lean webhook for the new player
    const webhookPayload = {
        player_id: player.playerId,
        player_name: player.playerName,
        status: 'joined'
    };
    await dispatchEvent('player.joined', webhookPayload, session.sessionId);

    let gameReady = false;
    if (session.players.length === 2) {
        session.status = 'active';
        gameReady = true;
    }
    
    return { success: true, isReconnect: false, gameReady, session };
  }
}

module.exports = { createSession, getSession, addOrReconnectPlayer };
