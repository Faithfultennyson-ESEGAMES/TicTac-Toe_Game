const gameConfig = require('../config/gameConfig');
const { secondsToMilliseconds } = require('../utils/helpers');

class TimerManager {
  constructor(timers = gameConfig.timers) {
    this.turnTimers = new Map();
    this.disconnectTimers = new Map();
    this.timers = timers;
  }

  startTurnTimer(sessionId, callback, durationSeconds = this.timers.turnTimer) {
    this.clearTurnTimer(sessionId);

    const delay = secondsToMilliseconds(durationSeconds);
    const expiresAt = Date.now() + delay;
    const handle = setTimeout(() => {
      this.turnTimers.delete(sessionId);
      callback();
    }, delay);

    this.turnTimers.set(sessionId, { handle, expiresAt });
    return expiresAt;
  }

  clearTurnTimer(sessionId) {
    const entry = this.turnTimers.get(sessionId);
    if (entry) {
      clearTimeout(entry.handle);
      this.turnTimers.delete(sessionId);
    }
  }

  getTurnExpiry(sessionId) {
    const entry = this.turnTimers.get(sessionId);
    return entry ? entry.expiresAt : null;
  }

  startDisconnectTimer(sessionId, playerId, callback) {
    const key = `${sessionId}:${playerId}`;
    this.clearDisconnectTimer(sessionId, playerId);

    const duration = this.timers.disconnectTimer + this.timers.lagCompensation;
    const delay = secondsToMilliseconds(duration);
    const handle = setTimeout(() => {
      this.disconnectTimers.delete(key);
      callback();
    }, delay);

    this.disconnectTimers.set(key, { handle, expiresAt: Date.now() + delay });
    return this.disconnectTimers.get(key).expiresAt;
  }

  clearDisconnectTimer(sessionId, playerId) {
    const key = `${sessionId}:${playerId}`;
    const entry = this.disconnectTimers.get(key);
    if (entry) {
      clearTimeout(entry.handle);
      this.disconnectTimers.delete(key);
    }
  }

  clearSession(sessionId) {
    this.clearTurnTimer(sessionId);
    Array.from(this.disconnectTimers.keys()).forEach((key) => {
      if (key.startsWith(`${sessionId}:`)) {
        this.clearDisconnectTimer(sessionId, key.split(':')[1]);
      }
    });
  }

  clearAll() {
    Array.from(this.turnTimers.keys()).forEach((sessionId) => this.clearTurnTimer(sessionId));
    Array.from(this.disconnectTimers.entries()).forEach(([key]) => {
      const [sessionId, playerId] = key.split(':');
      this.clearDisconnectTimer(sessionId, playerId);
    });
  }
}

module.exports = TimerManager;
