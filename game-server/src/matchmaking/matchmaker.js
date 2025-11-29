const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const MatchQueue = require('./queue');
const { normalizePlayer } = require('../utils/helpers');
const GameStateStore = require('../game/gameState');

class Matchmaker extends EventEmitter {
  constructor({ queue, gameState }) {
    super();
    this.queue = queue || new MatchQueue();
    this.gameState = gameState;
  }

  isPlayerEligible(playerId) {
    return !this.gameState.playerHasActiveSession(playerId);
  }

  addPlayerToQueue(playerData) {
    const normalized = {
      ...normalizePlayer(playerData),
      socketId: playerData.socketId,
      joinedAt: Date.now(),
    };

    if (!this.isPlayerEligible(normalized.id)) {
      const existingSession = this.gameState.getPlayerSession(normalized.id);
      logger.debug('Player attempted to queue while bound to session', {
        playerId: normalized.id,
        sessionId: existingSession?.sessionId,
        sessionStatus: existingSession?.status,
      });
      return {
        status: 'in-session',
        session: existingSession,
      };
    }

    const size = this.queue.enqueue(normalized);
    logger.info('Player joined matchmaking queue', {
      playerId: normalized.id,
      queueSize: size,
    });

    const session = this.tryCreateMatch();

    if (session) {
      return { status: 'matched', session };
    }

    return {
      status: 'queued',
      position: size,
    };
  }

  removePlayer(playerId) {
    const removed = this.queue.remove(playerId);
    if (removed) {
      logger.debug('Player removed from matchmaking queue', { playerId });
    }
    return removed;
  }

  tryCreateMatch() {
    let attempts = 0;
    while (attempts < 50) {
      const pair = this.queue.nextPair();
      if (!pair) {
        return null;
      }

      attempts += 1;
      const [playerOne, playerTwo] = pair;

      const playerOneEligible = this.isPlayerEligible(playerOne.id);
      const playerTwoEligible = this.isPlayerEligible(playerTwo.id);

      if (!playerOneEligible || !playerTwoEligible) {
        logger.warn('Discarding queued players due to existing sessions', {
          playerOne: { id: playerOne.id, eligible: playerOneEligible },
          playerTwo: { id: playerTwo.id, eligible: playerTwoEligible },
        });

        if (playerOneEligible) {
          this.queue.enqueue(playerOne);
        }
        if (playerTwoEligible) {
          this.queue.enqueue(playerTwo);
        }
        continue;
      }

      const sessionId = uuidv4();
      this.gameState.createSession({
        sessionId,
        players: {
          X: {
            ...playerOne,
            symbol: 'X',
            connected: true,
          },
          O: {
            ...playerTwo,
            symbol: 'O',
            connected: true,
          },
        },
      });

      const session = this.gameState.getSession(sessionId);
      logger.info('Match created', {
        lifecycle: 'session-created',
        sessionId,
        playerX: playerOne.id,
        playerO: playerTwo.id,
      });

      this.emit('match-found', session);
      return session;
    }

    logger.error('Failed to create match after multiple attempts', { attempts });
    return null;
  }

  getQueueSize() {
    return this.queue.size();
  }

  getQueuedPlayers() {
    return this.queue.list();
  }
}

Matchmaker.STATUSES = GameStateStore.STATUSES;

module.exports = Matchmaker;
