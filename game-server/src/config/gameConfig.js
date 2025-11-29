const path = require('path');

const parseIntWithFallback = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const BOARD_SIZE = 3;

const generateWinConditions = (size) => {
  const lines = [];
  const cells = size * size;

  for (let row = 0; row < size; row += 1) {
    const start = row * size;
    lines.push(Array.from({ length: size }, (_, offset) => start + offset));
  }

  for (let col = 0; col < size; col += 1) {
    lines.push(Array.from({ length: size }, (_, offset) => col + offset * size));
  }

  lines.push(Array.from({ length: size }, (_, offset) => offset * (size + 1)));
  lines.push(Array.from({ length: size }, (_, offset) => (offset + 1) * (size - 1)));

  return lines.filter((line) => line.every((index) => index >= 0 && index < cells));
};

const gameConfig = {
  server: {
    port: parseIntWithFallback(process.env.PORT, 3001),
    env: process.env.NODE_ENV || 'development',
  },
  timers: {
    turnTimer: parseIntWithFallback(process.env.TURN_TIMER, 30),
    disconnectTimer: parseIntWithFallback(process.env.DISCONNECT_TIMER, 5),
    lagCompensation: parseIntWithFallback(process.env.LAG_COMPENSATION, 1),
  },
  game: {
    boardSize: BOARD_SIZE,
    maxPlayers: 2,
    winConditions: generateWinConditions(BOARD_SIZE),
  },
  staking: {
    houseFee: 0.2,
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    directory: process.env.LOG_DIR
      ? path.resolve(process.cwd(), process.env.LOG_DIR)
      : path.resolve(process.cwd(), 'logs'),
  },
  external: {
    resultEndpoint: process.env.REACT_APP_RESULT_ENDPOINT || null,
  },
  metadata: {
    version: 'phase-1',
  },
};

module.exports = gameConfig;
