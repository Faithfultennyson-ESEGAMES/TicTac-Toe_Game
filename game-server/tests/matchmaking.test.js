jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  writeGameLog: jest.fn().mockResolvedValue(undefined),
}));

const Matchmaker = require('../src/matchmaking/matchmaker');
const MatchQueue = require('../src/matchmaking/queue');
const GameStateStore = require('../src/game/gameState');

describe('Matchmaker', () => {
  test('matches two players from the queue', (done) => {
    const queue = new MatchQueue();
    const gameState = new GameStateStore();
    const matchmaker = new Matchmaker({ queue, gameState });

    matchmaker.once('match-found', (session) => {
      expect(session.players.X.id).toBe('p1');
      expect(session.players.O.id).toBe('p2');
      expect(matchmaker.getQueueSize()).toBe(0);
      done();
    });

    const first = matchmaker.addPlayerToQueue({ id: 'p1', name: 'Player 1', stake: 100, socketId: 's1' });
    expect(first.status).toBe('queued');

    const second = matchmaker.addPlayerToQueue({ id: 'p2', name: 'Player 2', stake: 100, socketId: 's2' });
    expect(second.status).toBe('matched');
    expect(second.session.sessionId).toBeDefined();
  });

  test('removes player from queue', () => {
    const queue = new MatchQueue();
    const gameState = new GameStateStore();
    const matchmaker = new Matchmaker({ queue, gameState });

    matchmaker.addPlayerToQueue({ id: 'p1', name: 'Player 1', stake: 100, socketId: 's1' });
    expect(matchmaker.getQueueSize()).toBe(1);

    const removed = matchmaker.removePlayer('p1');
    expect(removed).toBe(true);
    expect(matchmaker.getQueueSize()).toBe(0);
  });

  test('prevents players with active sessions from re-queueing', () => {
    const queue = new MatchQueue();
    const gameState = new GameStateStore();
    const matchmaker = new Matchmaker({ queue, gameState });

    const first = matchmaker.addPlayerToQueue({ id: 'p1', name: 'Player 1', socketId: 's1' });
    expect(first.status).toBe('queued');
    matchmaker.addPlayerToQueue({ id: 'p2', name: 'Player 2', socketId: 's2' });

    const existingSession = gameState.getPlayerSession('p1');
    expect(existingSession).toBeDefined();

    const attempt = matchmaker.addPlayerToQueue({ id: 'p1', name: 'Player 1', socketId: 's1' });
    expect(attempt.status).toBe('in-session');
    expect(attempt.session.sessionId).toBe(existingSession.sessionId);
  });
});
