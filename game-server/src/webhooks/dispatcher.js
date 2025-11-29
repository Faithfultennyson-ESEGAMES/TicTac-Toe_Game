const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { nowTimestamp } = require('../utils/helpers');

const createWebhookDispatcher = (config) => {
  const { webhookEndpoints, hmacSecret, maxAttempts, retrySchedule, dlq } = config;

  const dispatch = async (event) => {
    const signature = crypto.createHmac('sha256', hmacSecret).update(JSON.stringify(event)).digest('hex');
    const headers = {
      'X-Timestamp': event.timestamp,
      'X-Signature': `sha256=${signature}`,
      'X-Event-ID': event.event_id,
    };

    for (const endpoint of webhookEndpoints) {
      sendWithRetry(endpoint, event, headers);
    }
  };

  const sendWithRetry = async (endpoint, event, headers, attempt = 1) => {
    try {
      await axios.post(endpoint, event, { headers: { ...headers, 'X-Attempt': attempt } });
    } catch (error) {
      if (error.response && error.response.status >= 400 && error.response.status < 500) {
        await dlq.add(endpoint, event, headers, error.response.status);
      } else if (attempt < maxAttempts) {
        const delay = retrySchedule[attempt - 1] || retrySchedule[retrySchedule.length - 1];
        setTimeout(() => sendWithRetry(endpoint, event, headers, attempt + 1), delay);
      } else {
        await dlq.add(endpoint, event, headers, error.response ? error.response.status : 'network_error');
      }
    }
  };

  return {
    dispatch,
  };
};

module.exports = createWebhookDispatcher;
