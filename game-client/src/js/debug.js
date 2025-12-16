const IS_DEBUG_MODE = false; // Switch to false to disable logs

const log = (...args) => {
  if (IS_DEBUG_MODE) {
    console.log('[DEBUG]', ...args);
  }
};

const warn = (...args) => {
  if (IS_DEBUG_MODE) {
    console.warn('[DEBUG]', ...args);
  }
};

const error = (...args) => {
  if (IS_DEBUG_MODE) {
    console.error('[DEBUG]', ...args);
  }
};

export default {
  log,
  warn,
  error,
};