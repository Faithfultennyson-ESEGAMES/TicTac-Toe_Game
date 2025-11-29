const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// A simple file-based log for game events, to be replaced by a proper event store.
logger.writeGameLog = async (sessionId, data) => {
  // This is a placeholder. In a real system, this would write to a structured log or database.
  logger.info('GAME_LOG', { sessionId, data });
};

module.exports = logger;
