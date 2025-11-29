const { v4: uuidv4 } = require('uuid');
const { nowTimestamp } = require('../utils/helpers');

const createDlq = () => {
  const dlq = new Map();

  const add = async (endpoint, event, headers, status) => {
    const id = uuidv4();
    dlq.set(id, {
      id,
      endpoint,
      event,
      headers,
      status,
      createdAt: nowTimestamp(),
    });
  };

  const get = (id) => {
    return dlq.get(id);
  };

  const list = () => {
    return Array.from(dlq.values());
  };

  const resend = async (id, dispatcher) => {
    const item = dlq.get(id);
    if (item) {
      dlq.delete(id);
      await dispatcher.dispatch(item.event);
      return true;
    } else {
      return false;
    }
  };

  const clear = (password, dlqPassword) => {
    if (password === dlqPassword) {
      dlq.clear();
      return true;
    } else {
      return false;
    }
  };

  return {
    add,
    get,
    list,
    resend,
    clear,
  };
};

module.exports = createDlq;
