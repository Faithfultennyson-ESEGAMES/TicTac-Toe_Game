class Timers {
  constructor() {
    this.sessionTimers = new Map();
  }

  startTurnTimer(sessionId, callback) {
    this.clearSession(sessionId);
    const timerId = setTimeout(callback, 15000); // 15s turn timer
    this.sessionTimers.set(sessionId, timerId);
    return Date.now() + 15000;
  }

  clearSession(sessionId) {
    if (this.sessionTimers.has(sessionId)) {
      clearTimeout(this.sessionTimers.get(sessionId));
      this.sessionTimers.delete(sessionId);
    }
  }
}

module.exports = Timers;
