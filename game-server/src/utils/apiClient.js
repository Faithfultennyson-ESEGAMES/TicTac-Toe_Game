const axios = require('axios');
const logger = require('./logger');

const createApiClient = (config) => {
  const client = axios.create({
    baseURL: config.matchmakingServiceUrl,
    timeout: config.timeout || 5000,
    headers: {
      'Content-Type': 'application/json',
    }
  });

  const reportSessionClosed = async (sessionId) => {
    try {
      const response = await client.post('/session-closed', { sessionId });
      logger.info('Successfully reported session closure to matchmaking service', { sessionId });
      return response.data;
    } catch (error) {
      logger.error('Error reporting session closure to matchmaking service', { 
        sessionId, 
        error: error.message, 
        serviceUrl: config.matchmakingServiceUrl 
      });
      throw error;
    }
  };

  return {
    reportSessionClosed,
  };
};

module.exports = createApiClient;
