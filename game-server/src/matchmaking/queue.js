class MatchQueue {
  constructor() {
    this.queue = [];
  }

  enqueue(player) {
    const exists = this.queue.some((entry) => entry.player.id === player.id);
    if (!exists) {
      this.queue.push({
        player,
        queuedAt: Date.now(),
      });
    }
    return this.size();
  }

  remove(playerId) {
    const index = this.queue.findIndex((entry) => entry.player.id === playerId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      return true;
    }
    return false;
  }

  nextPair() {
    if (this.queue.length < 2) {
      return null;
    }

    const [first, second] = this.queue.splice(0, 2);
    return [first.player, second.player];
  }

  hasPlayer(playerId) {
    return this.queue.some((entry) => entry.player.id === playerId);
  }

  size() {
    return this.queue.length;
  }

  list() {
    return this.queue.map((entry) => ({
      player: entry.player,
      queuedAt: entry.queuedAt,
    }));
  }
}

module.exports = MatchQueue;
