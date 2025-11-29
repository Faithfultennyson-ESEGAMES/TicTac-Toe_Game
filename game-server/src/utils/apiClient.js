const gameConfig = require('../config/gameConfig');
const logger = require('./logger');

class ApiClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
  }

  async reportGameResult(resultPayload) {
    if (!this.endpoint) {
      logger.debug('Skipping result report - endpoint missing');
      return { skipped: true };
    }

    if (typeof fetch !== 'function') {
      logger.warn('Global fetch is not available - cannot send result');
      return { skipped: true };
    }

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(resultPayload),
      });

      if (!response.ok) {
        logger.warn('Result endpoint responded with non-OK status', {
          status: response.status,
          statusText: response.statusText,
        });
      }

      return { ok: response.ok };
    } catch (error) {
      logger.warn('Failed to send result to external endpoint', {
        error: error.message,
      });
      return { error: error.message };
    }
  }
}

module.exports = new ApiClient(gameConfig.external.resultEndpoint);
