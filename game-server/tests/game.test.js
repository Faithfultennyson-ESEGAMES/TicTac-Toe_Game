jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  writeGameLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/utils/apiClient', () => ({
  reportGameResult: jest.fn().mockResolvedValue({ ok: true }),
}));

const GameStateStore = require('../src/game/gameState');
const TimerManager = require('../src/game/timers');
const GameEngine = require('../src/game/gameEngine');

const createEngine = () => {
  const gameState = new GameStateStore();
  const timers = new TimerManager({
    turnTimer: 60,
    disconnectTimer: 60,
    lagCompensation: 0,
  });
  const engine = new GameEngine({ gameState, timers });

  return { gameState, timers, engine };
};

describe('GameEngine', () => {
  test('applies a valid move and switches turn', async () => {
    const { gameState, timers, engine } = createEngine();
    const session = gameState.createSession({
      players: {
        X: { id: 'p1', name: 'Player 1', stake: 100 },
        O: { id: 'p2', name: 'Player 2', stake: 100 },
      },
    });

    engine.startSession(session.sessionId);

    const result = await engine.handlePlayerMove({
      sessionId: session.sessionId,
      playerId: 'p1',
      position: 0,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('active');
    expect(result.session.board[0]).toBe('X');
    expect(result.session.currentTurn).toBe('O');

    timers.clearAll();
  });

  test('detects winning move and completes session', async () => {
    const { gameState, timers, engine } = createEngine();
    const session = gameState.createSession({
      players: {
        X: { id: 'p1', name: 'Player 1', stake: 100 },
        O: { id: 'p2', name: 'Player 2', stake: 100 },
      },
    });

    engine.startSession(session.sessionId);

    await engine.handlePlayerMove({ sessionId: session.sessionId, playerId: 'p1', position: 0 });
    await engine.handlePlayerMove({ sessionId: session.sessionId, playerId: 'p2', position: 3 });
    await engine.handlePlayerMove({ sessionId: session.sessionId, playerId: 'p1', position: 1 });
    await engine.handlePlayerMove({ sessionId: session.sessionId, playerId: 'p2', position: 4 });
    const result = await engine.handlePlayerMove({ sessionId: session.sessionId, playerId: 'p1', position: 2 });

    expect(result.status).toBe('completed');
    expect(result.session.result.outcome).toBe('win');
    expect(result.session.result.winnerSymbol).toBe('X');

    const stats = gameState.getSessionStats();
    expect(stats.counts[GameStateStore.STATUSES.COMPLETED]).toBe(1);

    timers.clearAll();
  });

  test('prevents invalid move on occupied cell', async () => {
    const { gameState, timers, engine } = createEngine();
    const session = gameState.createSession({
      players: {
        X: { id: 'p1', name: 'Player 1', stake: 100 },
        O: { id: 'p2', name: 'Player 2', stake: 100 },
      },
    });

    engine.startSession(session.sessionId);

    await engine.handlePlayerMove({ sessionId: session.sessionId, playerId: 'p1', position: 0 });
    const invalid = await engine.handlePlayerMove({ sessionId: session.sessionId, playerId: 'p2', position: 0 });

    expect(invalid.error).toBe('cell_occupied');

    timers.clearAll();
  });

  test('tracks concurrent active sessions in stats', () => {
    const { gameState, timers, engine } = createEngine();

    const sessionA = gameState.createSession({
      players: {
        X: { id: 'a1', name: 'Alpha', stake: 50 },
        O: { id: 'a2', name: 'Beta', stake: 50 },
      },
    });
    const sessionB = gameState.createSession({
      players: {
        X: { id: 'b1', name: 'Gamma', stake: 50 },
        O: { id: 'b2', name: 'Delta', stake: 50 },
      },
    });

    engine.startSession(sessionA.sessionId);
    engine.startSession(sessionB.sessionId);

    const stats = gameState.getSessionStats();
    expect(stats.counts[GameStateStore.STATUSES.ACTIVE]).toBe(2);

    timers.clearSession(sessionA.sessionId);
    timers.clearSession(sessionB.sessionId);
  });
});
