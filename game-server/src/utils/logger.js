const fs = require('fs');
const path = require('path');
const gameConfig = require('../config/gameConfig');
const { nowTimestamp } = require('./helpers');

const LEVELS = ['error', 'warn', 'info', 'debug'];

const resolveLogPath = (fileName) => path.resolve(gameConfig.logging.directory, fileName);

const ensureDirectory = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

class Logger {
  constructor() {
    this.level = gameConfig.logging.level;
    ensureDirectory(gameConfig.logging.directory);
  }

  shouldLog(level) {
    return LEVELS.indexOf(level) <= LEVELS.indexOf(this.level);
  }

  log(level, message, meta = {}) {
    if (!LEVELS.includes(level)) {
      throw new Error(`Unknown log level: ${level}`);
    }

    if (!this.shouldLog(level)) {
      return;
    }

    const payload = {
      timestamp: nowTimestamp(),
      level,
      message,
      ...Object.keys(meta).length ? { meta } : {},
    };

    const output = `[${payload.timestamp}] ${level.toUpperCase()}: ${message}`;
    if (meta && Object.keys(meta).length) {
      console.log(output, meta);
    } else {
      console.log(output);
    }
  }

  info(message, meta) {
    this.log('info', message, meta);
  }

  warn(message, meta) {
    this.log('warn', message, meta);
  }

  error(message, meta) {
    this.log('error', message, meta);
  }

  debug(message, meta) {
    this.log('debug', message, meta);
  }

  async writeGameLog(sessionId, data) {
    try {
      ensureDirectory(gameConfig.logging.directory);
      const fileName = `game-${sessionId}-${Date.now()}.json`;
      const filePath = resolveLogPath(fileName);
      const payload = JSON.stringify({
        sessionId,
        writtenAt: nowTimestamp(),
        ...data,
      }, null, 2);
      await fs.promises.writeFile(filePath, payload, 'utf8');
      this.info('Game session logged', { sessionId, filePath });
    } catch (error) {
      this.error('Failed to write game log', { sessionId, error: error.message });
    }
  }
}

module.exports = new Logger();
