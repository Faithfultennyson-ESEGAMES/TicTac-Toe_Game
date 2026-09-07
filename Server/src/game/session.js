require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const crypto = require('crypto');
const { dispatchEvent } = require('../webhooks/dispatcher');
const { checkForWinner } = require('./game_logic');
const sessionLogger = require('../logging/session_logger');
const { notifySessionClosed } = require('../webhooks/matchmaking_notifier');

// --- Constants ---
const sessions = new Map(); // sessionId -> session object
const activePlayerIds = new Map(); // playerId -> sessionId
const sessionsBySocket = new Map(); // socketId -> sessionId

// Whole-session lifetime is an optional emergency guard. 0 disables it so
// players can remain in the Ready lobby until the moderator ends the session.
const configuredLifetimeMs = Number.parseInt(process.env.SESSION_MAX_LIFETIME_MS, 10);
const SESSION_MAX_LIFETIME_MS = Number.isFinite(configuredLifetimeMs) && configuredLifetimeMs >= 0
  ? configuredLifetimeMs
  : 0;
const SESSION_CLEANUP_INTERVAL_MS = 300000; // 5 minutes
const MAX_TURNS = parseInt(process.env.MAX_TURNS, 10) || 12;
let sessionEndNotifier = null;

// --- Private Functions ---

async function _concludeAndCleanupSession(session) {
    if (!session) return;

    clearTimeout(session.expiryTimerId);
    session.expiryTimerId = null;

    await dispatchEvent('session.ended', session, session.sessionId);

    // Notify the matchmaking service that the session is officially over.
    await notifySessionClosed(session);

    for (const player of session.players) {
        if (player) {
            activePlayerIds.delete(player.playerId);
            if (player.socketId) {
                sessionsBySocket.delete(player.socketId);
            }
        }
    }

    sessions.delete(session.sessionId);
}

async function _cleanupStaleSessions() {
  const now = Date.now();
  console.log('[Session] Running stale session cleanup...');

  for (const session of sessions.values()) {
    if (session.status === 'ended') {
      continue;
    }

    const sessionAge = now - new Date(session.createdAt).getTime();

    if (SESSION_MAX_LIFETIME_MS > 0 && sessionAge > SESSION_MAX_LIFETIME_MS) {
      console.log(`[Session] Stale session ${session.sessionId} (created at ${session.createdAt}, status: ${session.status}) found. Auto-ending.`);
      await endSession(session.sessionId, 'stale', session.startedAt ? 'draw' : 'none', null);
    }
  }
}

// --- Public API ---

function init() {
  if (SESSION_MAX_LIFETIME_MS <= 0) {
    console.log('[Session] Whole-session lifetime guard is disabled (SESSION_MAX_LIFETIME_MS=0).');
    return;
  }
  setInterval(_cleanupStaleSessions, SESSION_CLEANUP_INTERVAL_MS);
  console.log(`[Session] Stale session cleanup initiated. Will run every ${SESSION_CLEANUP_INTERVAL_MS / 60000} minutes.`);
  console.log(`[Session] Sessions older than ${SESSION_MAX_LIFETIME_MS / 3600000} hour(s) will be terminated.`);
}

async function endSession(sessionId, clientReason, webhookWinState, winnerPlayerId) {
    const session = getSession(sessionId);
    if (!session || session.status === 'ended') {
        return null;
    }

    clearTimeout(session.turnTimerId);
    session.turnTimerId = null;

    // A session that never reached gameplay must never be reported as a draw
    // or a win. This prevents pre-start expiry/admin termination from looking
    // like a settled wager result.
    const neverStarted = !session.startedAt;
    const finalWinState = neverStarted ? 'none' : webhookWinState;
    const finalWinnerPlayerId = neverStarted ? null : winnerPlayerId;

    session.status = 'ended';
    session.winState = finalWinState;
    session.winnerPlayerId = finalWinnerPlayerId;
    session.endReason = clientReason;

    sessionLogger.finalizeLog(session, { winState: finalWinState, winnerPlayerId: finalWinnerPlayerId });
    const payload = {
      reason: clientReason,
      board: session.board,
      sessionId: session.sessionId,
      winState: finalWinState,
      winnerPlayerId: finalWinnerPlayerId,
      players: session.players.map((player) => ({
        playerId: player.playerId,
        playerName: player.playerName,
        symbol: player.symbol,
      })),
    };
    if (!['win', 'draw'].includes(clientReason) && typeof sessionEndNotifier === 'function') {
      try {
        sessionEndNotifier(session, payload);
      } catch (error) {
        console.error(`[Session] Failed to notify sockets for ${session.sessionId}:`, error);
      }
    }
    await _concludeAndCleanupSession(session);

    return payload;
}

function createSession(turnDurationSec = 10) {
  const sessionId = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = SESSION_MAX_LIFETIME_MS > 0
    ? new Date(createdAt.getTime() + SESSION_MAX_LIFETIME_MS)
    : null;
  const session = {
    sessionId,
    status: 'pending',
    players: [],
    board: Array(9).fill(null),
    turnDurationSec,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    startedAt: null,
    currentTurnPlayerId: null,
    winState: null,
    winnerPlayerId: null,
    turnCount: 0,
  };

  // Timer handles are runtime-only implementation details. Keep them non-enumerable
  // so session logging/webhook serialization never sees Node's circular Timeout objects.
  Object.defineProperties(session, {
    expiryTimerId: { value: null, writable: true, configurable: true, enumerable: false },
    turnTimerId: { value: null, writable: true, configurable: true, enumerable: false },
  });

  sessions.set(sessionId, session);
  if (expiresAt) {
    const remainingMs = Math.max(0, expiresAt.getTime() - Date.now());
    session.expiryTimerId = setTimeout(() => {
      const current = getSession(sessionId);
      const winState = current && current.startedAt ? 'draw' : 'none';
      endSession(sessionId, 'expired', winState, null).catch((error) => {
        console.error(`[Session] Failed to expire session ${sessionId}:`, error);
      });
    }, remainingMs);
  }
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function setSessionEndNotifier(notifier) {
  sessionEndNotifier = typeof notifier === 'function' ? notifier : null;
}

function getAllActiveSessions() {
  const activeSessions = [];
  for (const session of sessions.values()) {
    if (session.status !== 'ended') {
      const sanitizedPlayers = session.players.map(p => ({
        playerId: p.playerId,
        playerName: p.playerName,
        symbol: p.symbol,
        ready: Boolean(p.ready),
        connected: Boolean(p.socketId),
      }));

      activeSessions.push({
        sessionId: session.sessionId,
        status: session.status,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        turnDurationSec: session.turnDurationSec,
        turnCount: session.turnCount,
        currentTurnPlayerId: session.currentTurnPlayerId,
        players: sanitizedPlayers,
      });
    }
  }
  return activeSessions;
}

function _isValidReconnectToken(player, reconnectToken) {
  if (!player || !player.reconnectToken || typeof reconnectToken !== 'string') return false;
  const expected = Buffer.from(player.reconnectToken);
  const received = Buffer.from(reconnectToken);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

async function addOrReconnectPlayer(sessionId, playerId, playerName, socketId, reconnectToken = null) {
  const session = getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found.' };
  }

  if (activePlayerIds.has(playerId) && activePlayerIds.get(playerId) !== sessionId) {
    return { success: false, error: 'Player already in another session.' };
  }

  const existingPlayer = session.players.find(p => p.playerId === playerId);
  let isReconnect = false;

  if (existingPlayer) {
    // Re-sending join on the exact same live socket is idempotent. A different
    // socket must prove possession of the private reconnect token issued on the
    // player's first successful join; playerId alone is never sufficient.
    if (existingPlayer.socketId === socketId) {
      return {
        success: true,
        isReconnect: false,
        gameReady: session.status === 'active',
        reconnectToken: existingPlayer.reconnectToken,
        session,
      };
    }
    const reconnectAuthorized = _isValidReconnectToken(existingPlayer, reconnectToken);
    if (existingPlayer.socketId) {
      // A fast page/WebView reload can establish the new socket before the old
      // socket's disconnect reaches the server. A valid private reconnect token
      // is enough to authorize takeover of that stale/live socket binding.
      // Remove the old socket mapping first so its eventual disconnect cannot
      // clear the newly connected socket.
      if (!reconnectAuthorized) {
        return { success: false, error: reconnectToken ? 'Reconnect authorization failed.' : 'Player is already connected.' };
      }
      sessionsBySocket.delete(existingPlayer.socketId);
    } else if (!reconnectAuthorized) {
      return { success: false, error: 'Reconnect authorization failed.' };
    }

    isReconnect = true;
    existingPlayer.socketId = socketId;
    sessionsBySocket.set(socketId, sessionId);

    sessionLogger.appendEvent(sessionId, 'player.reconnected', { playerId: playerId });
    await dispatchEvent('player.reconnected', { sessionId, playerId: playerId, status: 'reconnected' }, sessionId);
  } else {
    if (session.players.length >= 2 || session.status !== 'pending') {
      return { success: false, error: 'Session is full or has already started.' };
    }

    const player = {
      playerId,
      playerName,
      socketId,
      symbol: session.players.length === 0 ? 'X' : 'O',
      ready: false,
    };
    // Runtime-only secret: intentionally non-enumerable so logs/webhooks never
    // serialize it with the public player/session payload.
    Object.defineProperty(player, 'reconnectToken', {
      value: crypto.randomBytes(32).toString('hex'),
      writable: false,
      configurable: false,
      enumerable: false,
    });
    session.players.push(player);
    activePlayerIds.set(playerId, sessionId);
    sessionsBySocket.set(socketId, sessionId);

    sessionLogger.appendEvent(sessionId, 'player.joined', { playerId: playerId, playerName: playerName });
    await dispatchEvent('player.joined', { sessionId, playerId: playerId, playerName: playerName, status: 'joined' }, sessionId);

  }

  const joinedPlayer = session.players.find(p => p.playerId === playerId);
  return {
    success: true,
    isReconnect,
    gameReady: session.status === 'active',
    reconnectToken: joinedPlayer ? joinedPlayer.reconnectToken : null,
    session,
  };
}

async function setPlayerReady(sessionId, playerId) {
  const session = getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found.' };
  }

  const player = session.players.find(p => p.playerId === playerId);
  if (!player) {
    return { success: false, error: 'Player not in session.' };
  }

  // Ready is intentionally idempotent across the pending -> active boundary.
  // A delayed retry can arrive after the second Ready already activated the game;
  // that duplicate must still be confirmed rather than rejected.
  if (session.status === 'active' && player.ready) {
    return {
      success: true,
      playerId,
      ready: true,
      bothReady: true,
      alreadyActive: true,
      session,
    };
  }

  if (session.status !== 'pending') {
    return { success: false, error: 'Session is not accepting Ready.' };
  }

  if (!player.ready) {
    player.ready = true;
    sessionLogger.appendEvent(sessionId, 'player.ready', { playerId });
    await dispatchEvent('player.ready', { sessionId, playerId, status: 'ready' }, sessionId);
  }

  const bothReady = session.players.length === 2 && session.players.every(p => p.ready && p.socketId);
  if (bothReady) {
    session.status = 'active';
    session.currentTurnPlayerId = session.players[0].playerId;
    session.startedAt = new Date().toISOString();

    sessionLogger.appendEvent(sessionId, 'session.started', {
      currentTurnPlayerId: session.currentTurnPlayerId,
      startedAt: session.startedAt,
    });
    await dispatchEvent('session.started', {
      sessionId,
      status: 'active',
      startedAt: session.startedAt,
      currentTurnPlayerId: session.currentTurnPlayerId,
      players: session.players.map(p => ({
        playerId: p.playerId,
        playerName: p.playerName,
        symbol: p.symbol,
        ready: Boolean(p.ready),
      })),
    }, sessionId);
  }

  return {
    success: true,
    playerId,
    ready: true,
    bothReady,
    alreadyActive: false,
    session,
  };
}

async function makeMove(sessionId, playerId, position) {
  const session = getSession(sessionId);

  if (!session || session.status !== 'active') {
    return { success: false, error: 'Session not active.' };
  }
  if (playerId !== session.currentTurnPlayerId) {
    return { success: false, error: 'Not your turn.' };
  }
  if (position < 0 || position > 8 || session.board[position] !== null) {
    return { success: false, error: 'Invalid move.' };
  }

  const player = session.players.find(p => p.playerId === playerId);
  const symbolCount = session.board.filter(s => s === player.symbol).length;

  if (symbolCount >= 3) {
    return { success: false, error: 'You have placed all your symbols. You must relocate one.' };
  }

  clearTimeout(session.turnTimerId);
  session.turnTimerId = null;

  session.board[position] = player.symbol;
  session.turnCount++;

  sessionLogger.appendEvent(sessionId, 'move.made', { playerId: playerId, position });

  const winnerSymbol = checkForWinner(session.board);
  if (winnerSymbol) {
    const winner = session.players.find(p => p.symbol === winnerSymbol);
    const payload = await endSession(sessionId, 'win', 'win', winner.playerId);
    return { success: true, gameEnded: true, payload };
  }

  if (session.turnCount >= MAX_TURNS) {
    const payload = await endSession(sessionId, 'draw', 'draw', null);
    return { success: true, gameEnded: true, payload };
  }

  const otherPlayer = session.players.find(p => p.playerId !== playerId);
  session.currentTurnPlayerId = otherPlayer.playerId;
  return { success: true, gameEnded: false, board: session.board, nextTurnPlayerId: session.currentTurnPlayerId };
}

async function relocateMove(sessionId, playerId, from, to) {
    const session = getSession(sessionId);

    if (!session || session.status !== 'active') {
        return { success: false, error: 'Session not active.' };
    }
    if (playerId !== session.currentTurnPlayerId) {
        return { success: false, error: 'Not your turn.' };
    }
    const player = session.players.find(p => p.playerId === playerId);
    if (!player) {
        return { success: false, error: 'Player not in session.' };
    }

    if (from < 0 || from > 8 || to < 0 || to > 8) {
        return { success: false, error: 'Invalid move coordinates.' };
    }
    if (session.board[from] !== player.symbol) {
        return { success: false, error: 'The "from" position does not contain your symbol.' };
    }
    if (session.board[to] !== null) {
        return { success: false, error: 'The "to" position is already occupied.' };
    }
    
    const symbolCount = session.board.filter(s => s === player.symbol).length;
    if (symbolCount < 3) {
      return { success: false, error: 'You must place all your symbols before you can relocate.' };
    }

    clearTimeout(session.turnTimerId);
    session.turnTimerId = null;

    session.board[from] = null;
    session.board[to] = player.symbol;
    session.turnCount++;

    sessionLogger.appendEvent(sessionId, 'move.relocated', { playerId, from, to });

    const winnerSymbol = checkForWinner(session.board);
    if (winnerSymbol) {
        const winner = session.players.find(p => p.symbol === winnerSymbol);
        const payload = await endSession(sessionId, 'win', 'win', winner.playerId);
        return { success: true, gameEnded: true, payload };
    }

    if (session.turnCount >= MAX_TURNS) {
        const payload = await endSession(sessionId, 'draw', 'draw', null);
        return { success: true, gameEnded: true, payload };
    }

    const otherPlayer = session.players.find(p => p.playerId !== playerId);
    session.currentTurnPlayerId = otherPlayer.playerId;
    return { success: true, gameEnded: false, board: session.board, nextTurnPlayerId: session.currentTurnPlayerId };
}


async function handleDisconnect(socketId) {
  const sessionId = sessionsBySocket.get(socketId);
  if (!sessionId) return null;

  const session = getSession(sessionId);
  if (!session) return null;

  const player = session.players.find(p => p.socketId === socketId);
  if (!player) return null;

  sessionsBySocket.delete(socketId);
  player.socketId = null;

  if (session.status === 'pending') {
      // A Ready vote is only valid while that player is actually present in
      // the lobby. If they leave before start, require them to reconnect and
      // explicitly Ready again so a stale vote can never auto-start a match.
      player.ready = false;
  } else if (session.status === 'active') {
      sessionLogger.appendEvent(sessionId, 'player.disconnected', { playerId: player.playerId });
      await dispatchEvent('player.disconnected', { sessionId, playerId: player.playerId, status: 'disconnected' }, sessionId);
  }

  return { session, disconnectedPlayerId: player.playerId };
}

async function passTurn(sessionId) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active') {
    return { success: false };
  }

  session.turnCount++;

  const timedOutPlayerId = session.currentTurnPlayerId;
  sessionLogger.appendEvent(sessionId, 'player.turn_passed', { playerId: timedOutPlayerId });
  await dispatchEvent('player.turn_passed', { sessionId, playerId: timedOutPlayerId, reason: 'timeout' }, sessionId);

  if (session.turnCount >= MAX_TURNS) {
    const payload = await endSession(sessionId, 'draw', 'draw', null);
    return { success: true, gameEnded: true, payload };
  }

  const otherPlayer = session.players.find(p => p.playerId !== timedOutPlayerId);
  session.currentTurnPlayerId = otherPlayer.playerId;

  return { success: true, gameEnded: false, session, nextTurnPlayerId: session.currentTurnPlayerId };
}

module.exports = {
  init,
  createSession,
  getSession,
  getAllActiveSessions,
  addOrReconnectPlayer,
  makeMove,
  relocateMove,
  handleDisconnect,
  passTurn,
  endSession,
  setPlayerReady,
  setSessionEndNotifier,
};
