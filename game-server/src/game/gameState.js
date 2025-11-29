const { v4: uuidv4 } = require('uuid');
const gameConfig = require('../config/gameConfig');
const { calculateStakes, clone, nowTimestamp } = require('../utils/helpers');

const SESSION_STATUSES = {
  CREATED: 'created',
  ACTIVE: 'active',
  DISCONNECT_PENDING: 'disconnect_pending',
  COMPLETED: 'completed',
};

class GameStateStore {
  constructor() {
    this.sessions = new Map();
    this.playerSessionIndex = new Map();
    this.startedAt = Date.now();
  }

  createSession({ sessionId, players, metadata = {} }) {
    const id = sessionId || uuidv4();
    const boardCellCount = gameConfig.game.boardSize ** 2;
    const board = Array.from({ length: boardCellCount }, () => null);

    const playerXStake = players?.X?.stake ?? 0;
    const playerOStake = players?.O?.stake ?? 0;
    const stakes = calculateStakes(playerXStake, playerOStake, gameConfig.staking.houseFee);

    const session = {
      sessionId: id,
      status: SESSION_STATUSES.CREATED,
      players: {
        X: {
          id: players.X?.id,
          name: players.X?.name,
          stake: playerXStake,
          socketId: players.X?.socketId || null,
          symbol: 'X',
          connected: players.X?.connected ?? true,
        },
        O: {
          id: players.O?.id,
          name: players.O?.name,
          stake: playerOStake,
          socketId: players.O?.socketId || null,
          symbol: 'O',
          connected: players.O?.connected ?? true,
        },
      },
      board,
      moves: [],
      metadata,
      currentTurn: 'X',
      createdAt: nowTimestamp(),
      updatedAt: nowTimestamp(),
      turnExpiresAt: null,
      result: null,
      stakes,
    };

    this.sessions.set(id, session);
    this.bindPlayersToSession(id, session.players);
    return clone(session);
  }

  bindPlayersToSession(sessionId, players) {
    ['X', 'O'].forEach((symbol) => {
      const playerId = players[symbol]?.id;
      if (playerId) {
        this.playerSessionIndex.set(playerId, sessionId);
      }
    });
  }

  unbindPlayersFromSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    ['X', 'O'].forEach((symbol) => {
      const playerId = session.players[symbol]?.id;
      if (playerId && this.playerSessionIndex.get(playerId) === sessionId) {
        this.playerSessionIndex.delete(playerId);
      }
    });
  }

  getPlayerSessionId(playerId) {
    if (!playerId) {
      return null;
    }
    return this.playerSessionIndex.get(playerId) || null;
  }

  getPlayerSession(playerId) {
    const sessionId = this.getPlayerSessionId(playerId);
    if (!sessionId) {
      return null;
    }
    return this.getSession(sessionId);
  }

  playerHasActiveSession(playerId) {
    const sessionId = this.getPlayerSessionId(playerId);
    if (!sessionId) {
      return false;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.playerSessionIndex.delete(playerId);
      return false;
    }
    return session.status !== SESSION_STATUSES.COMPLETED;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? clone(session) : null;
  }

  updateSession(sessionId, updater) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const nextSession = typeof updater === 'function' ? updater({ ...session }) : { ...session, ...updater };
    nextSession.updatedAt = nowTimestamp();
    this.sessions.set(sessionId, nextSession);
    return clone(nextSession);
  }

  appendMove(sessionId, move) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    session.moves.push(move);
    session.updatedAt = nowTimestamp();
    this.sessions.set(sessionId, session);
    return clone(session);
  }

  setStatus(sessionId, status) {
    return this.updateSession(sessionId, (session) => ({ ...session, status }));
  }

  setTurn(sessionId, turn, turnExpiresAt = null) {
    return this.updateSession(sessionId, (session) => ({
      ...session,
      currentTurn: turn,
      turnExpiresAt,
      turnStartedAt: nowTimestamp(),
    }));
  }

  setResult(sessionId, result) {
    const updated = this.updateSession(sessionId, (session) => ({
      ...session,
      status: SESSION_STATUSES.COMPLETED,
      result,
    }));
    this.unbindPlayersFromSession(sessionId);
    return updated;
  }

  setPlayerConnection(sessionId, playerSymbol, connected) {
    return this.updateSession(sessionId, (session) => ({
      ...session,
      players: {
        ...session.players,
        [playerSymbol]: {
          ...session.players[playerSymbol],
          connected,
        },
      },
    }));
  }

  removeSession(sessionId) {
    const removed = this.sessions.delete(sessionId);
    this.unbindPlayersFromSession(sessionId);
    return removed;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((session) => clone(session));
  }

  getSessionStats() {
    const counts = {
      [SESSION_STATUSES.CREATED]: 0,
      [SESSION_STATUSES.ACTIVE]: 0,
      [SESSION_STATUSES.DISCONNECT_PENDING]: 0,
      [SESSION_STATUSES.COMPLETED]: 0,
    };

    this.sessions.forEach((session) => {
      if (counts[session.status] !== undefined) {
        counts[session.status] += 1;
      }
    });

    return {
      counts,
      total: this.sessions.size,
    };
  }

  getActiveSessionsCount() {
    return this.getSessionStats().counts[SESSION_STATUSES.ACTIVE];
  }

  getPendingDisconnectCount() {
    return this.getSessionStats().counts[SESSION_STATUSES.DISCONNECT_PENDING];
  }

  getStartedAt() {
    return this.startedAt;
  }
}

GameStateStore.STATUSES = SESSION_STATUSES;

module.exports = GameStateStore;
