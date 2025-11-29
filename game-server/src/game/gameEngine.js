const logger = require('../utils/logger');
const apiClient = require('../utils/apiClient');
const { nowTimestamp } = require('../utils/helpers');
const validation = require('./validation');
const GameStateStore = require('./gameState');

class GameEngine {
  constructor({ gameState, timers }) {
    this.gameState = gameState;
    this.timers = timers;
  }

  startSession(sessionId) {
    const expiresAt = this.timers.startTurnTimer(sessionId, () => this.handleTurnTimeout(sessionId));
    const updated = this.gameState.updateSession(sessionId, (session) => ({
      ...session,
      status: GameStateStore.STATUSES.ACTIVE,
      turnExpiresAt: new Date(expiresAt).toISOString(),
      turnStartedAt: nowTimestamp(),
    }));

    if (updated) {
      logger.info('Session lifecycle transition', {
        lifecycle: 'session-active',
        sessionId,
        nextTurn: updated.currentTurn,
        turnExpiresAt: updated.turnExpiresAt,
      });
    }

    return updated;
  }

  async handlePlayerMove({ sessionId, playerId, position }) {
    const session = this.gameState.getSession(sessionId);
    const validationResult = validation.validateMove(session, playerId, position);

    if (!validationResult.valid) {
      return {
        error: validationResult.reason,
      };
    }

    const { playerSymbol } = validationResult;
    const moveTimestamp = nowTimestamp();

    const updatedSession = this.gameState.updateSession(sessionId, (state) => {
      const board = state.board.slice();
      board[position] = playerSymbol;

      return {
        ...state,
        board,
        moves: [
          ...state.moves,
          {
            index: position,
            symbol: playerSymbol,
            playerId,
            at: moveTimestamp,
          },
        ],
        status: GameStateStore.STATUSES.ACTIVE,
      };
    });

    const winningLine = validation.checkWin(updatedSession.board, playerSymbol);
    if (winningLine) {
      const result = await this.finishSession(sessionId, {
        outcome: 'win',
        winnerSymbol: playerSymbol,
        winningLine,
      });

      return {
        status: 'completed',
        session: result,
        winningLine,
      };
    }

    const draw = validation.checkDraw(updatedSession.board);
    if (draw) {
      const result = await this.finishSession(sessionId, {
        outcome: 'draw',
        winningLine: null,
      });

      return {
        status: 'completed',
        session: result,
      };
    }

    const nextTurn = playerSymbol === 'X' ? 'O' : 'X';
    const expiresAt = this.timers.startTurnTimer(sessionId, () => this.handleTurnTimeout(sessionId));

    const continuedSession = this.gameState.setTurn(sessionId, nextTurn, new Date(expiresAt).toISOString());

    return {
      status: 'active',
      session: continuedSession,
    };
  }

  async handleTurnTimeout(sessionId) {
    const session = this.gameState.getSession(sessionId);
    if (!session || session.status === GameStateStore.STATUSES.COMPLETED) {
      return;
    }

    if (session.status !== GameStateStore.STATUSES.ACTIVE && session.status !== GameStateStore.STATUSES.DISCONNECT_PENDING) {
      return;
    }

    const forfeitedSymbol = session.currentTurn;
    const winnerSymbol = forfeitedSymbol === 'X' ? 'O' : 'X';

    await this.finishSession(sessionId, {
      outcome: 'forfeit',
      reason: 'turn_timeout',
      winnerSymbol,
      forfeitedSymbol,
    });

    logger.warn('Turn timer expired', { sessionId, forfeitedSymbol });
  }

  async forfeitSession(sessionId, playerSymbol, reason = 'disconnect_timeout') {
    const session = this.gameState.getSession(sessionId);
    if (!session || session.status === GameStateStore.STATUSES.COMPLETED) {
      return null;
    }

    const winnerSymbol = playerSymbol === 'X' ? 'O' : 'X';
    const result = await this.finishSession(sessionId, {
      outcome: 'forfeit',
      reason,
      winnerSymbol,
      forfeitedSymbol: playerSymbol,
    });

    logger.warn('Session forfeited', { sessionId, playerSymbol, reason });
    return result;
  }

  async finishSession(sessionId, resultPayload) {
    this.timers.clearSession(sessionId);

    const completedAt = nowTimestamp();
    const updatedSession = this.gameState.setResult(sessionId, {
      ...resultPayload,
      completedAt,
    });

    if (updatedSession) {
      logger.info('Session lifecycle transition', {
        lifecycle: 'session-completed',
        sessionId,
        outcome: updatedSession.result?.outcome,
        reason: updatedSession.result?.reason || null,
      });

      await logger.writeGameLog(sessionId, {
        result: updatedSession.result,
        players: updatedSession.players,
        moves: updatedSession.moves,
        stakes: updatedSession.stakes,
        metadata: updatedSession.metadata,
      });

      apiClient.reportGameResult({
        sessionId,
        result: updatedSession.result,
        players: updatedSession.players,
        stakes: updatedSession.stakes,
      }).catch((error) => {
        logger.debug('Result API rejected', { error: error.message });
      });
    }

    return updatedSession;
  }
}

module.exports = GameEngine;
