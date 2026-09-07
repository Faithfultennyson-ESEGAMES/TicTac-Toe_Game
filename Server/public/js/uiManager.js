import audioManager from "./audioManager.js";

class UIManager {
  constructor() {
    this.boardEl = document.getElementById('game-board');
    this.boardWrapper = document.getElementById('board-wrapper');
    this.cells = Array.from(this.boardEl.querySelectorAll('.board-cell'));
    this.playerCards = {
      X: document.getElementById('player-x'),
      O: document.getElementById('player-o'),
    };
    this.playerNames = {
      X: document.getElementById('player-x-name'),
      O: document.getElementById('player-o-name'),
    };
    this.playerStakes = {
      X: document.getElementById('player-x-stake'),
      O: document.getElementById('player-o-stake'),
    };
    this.turnTextEl = document.getElementById('turn-text');
    this.timerEl = document.getElementById('turn-timer');
    this.statusIndicator = document.getElementById('status-indicator');
    this.statusText = document.getElementById('status-text');
    this.overlay = document.getElementById('overlay');
    this.overlayTitle = document.getElementById('overlay-title');
    this.overlayMessage = document.getElementById('overlay-message');
    this.overlayAction = document.getElementById('overlay-action');
    this.overlaySpinner = document.getElementById('overlay-spinner');
    this.resultModal = document.getElementById('result-modal');
    this.resultTitle = document.getElementById('result-title');
    this.resultSummary = document.getElementById('result-summary');
    this.endLeaderboard = document.getElementById('end-leaderboard');
    this.muteBtn = document.getElementById('mute-btn');
    this.muteIcon = document.getElementById('mute-icon');
    this.toastEl = null;
    this.lastMoveSoundAt = 0;
  }

  // Wire the master mute toggle and reflect the persisted preference.
  setupMuteButton() {
    if (!this.muteBtn) return;
    this.renderMuteState(audioManager.isMuted());
    this.muteBtn.addEventListener('click', () => {
      const muted = audioManager.toggleMuted();
      this.renderMuteState(muted);
      if (!muted) {
        // The unmute click itself is a user gesture, so use it to resume a
        // suspended WebAudio context and reassert background-music intent.
        audioManager.ensureContextReady().catch(() => {});
        audioManager.startMusic();
        audioManager.playClick();
      }
    });
  }

  renderMuteState(muted) {
    if (!this.muteBtn) return;
    this.muteBtn.classList.toggle('muted', muted);
    this.muteBtn.setAttribute('aria-pressed', String(muted));
    this.muteBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    if (this.muteIcon) {
      this.muteIcon.src = muted
        ? 'assets/icons/speaker_off.svg'
        : 'assets/icons/speaker_on.svg';
    }
  }

  playClick() {
    audioManager.playClick();
  }

  startMusic() {
    audioManager.startMusic();
  }

  bindBoardHandlers(handler) {
    this.cells.forEach((cell) => {
      cell.addEventListener('click', () => {
        handler(Number(cell.dataset.index));
      });
    });
  }

  setBoardVisible(visible) {
    if (!this.boardWrapper) return;
    this.boardWrapper.classList.toggle('hidden', !visible);
    this.boardWrapper.setAttribute('aria-hidden', String(!visible));
  }

  setBoardState(board) {
    board.forEach((value, index) => {
      const cell = this.cells[index];
      if (!cell) return;
      if (!value) {
        cell.textContent = '';
        cell.dataset.symbol = '';
        cell.classList.remove('winning');
        return;
      }
      cell.textContent = value;
      cell.dataset.symbol = value;
    });
  }

  setSelectedSymbol(index) {
    this.cells.forEach((cell, i) => {
        cell.classList.toggle('selected', i === index);
    });
  }

  markWinningCells(cells = []) {
    this.cells.forEach((cell, index) => {
      if (cells.includes(index)) {
        cell.classList.add('winning');
      } else {
        cell.classList.remove('winning');
      }
    });
  }

  formatPlayerName(name) {
    if (name === null || name === undefined) {
      return 'Waiting...';
    }
    const text = String(name).trim();
    if (!text) {
      return 'Waiting...';
    }
    if (text.length <= 12) {
      return text;
    }
    return `${text.slice(0, 10)}..`;
  }

  updatePlayers(players = {}) {
    ['X', 'O'].forEach((symbol) => {
      const card = this.playerCards[symbol];
      const info = players[symbol] || {};
      this.playerNames[symbol].textContent = this.formatPlayerName(info.name);
      this.playerStakes[symbol].textContent = info.stake ? `${info.stake} credits` : '';
      card.classList.toggle('disconnected', info.connected === false);
    });
  }

  setCurrentTurn(symbol, options = {}) {
    this.turnTextEl.textContent = symbol ? `${symbol} turn` : options.message || 'Waiting for players...';
    this.playerCards.X.classList.toggle('active', symbol === 'X');
    this.playerCards.O.classList.toggle('active', symbol === 'O');
  }

  updateTimer(label, state = 'normal') {
    this.timerEl.textContent = label;
    this.timerEl.classList.remove('warning', 'danger');
    if (state === 'warning') {
      this.timerEl.classList.add('warning');
    }
    if (state === 'danger') {
      this.timerEl.classList.add('danger');
    }
  }

  setConnectionStatus(status, message) {
    this.statusIndicator.classList.remove('connected', 'connecting', 'disconnected');
    this.statusIndicator.classList.add(status);
    if (message) {
      this.statusText.textContent = message;
    }
  }

  showOverlay({ title, message, actionLabel, actionHandler, showSpinner = true }) {
    this.overlay.classList.remove('banner', 'results');
    this.overlay.classList.remove('hidden');
    this.overlayTitle.textContent = title;
    this.overlayMessage.textContent = message;
    this.overlaySpinner.classList.toggle('hidden', !showSpinner);
    this.clearEndLeaderboard();
    if (actionLabel && actionHandler) {
      this.overlayAction.textContent = actionLabel;
      this.overlayAction.onclick = actionHandler;
      this.overlayAction.classList.remove('hidden');
    } else {
      this.overlayAction.classList.add('hidden');
      this.overlayAction.onclick = null;
    }
  }

  hideOverlay() {
    this.overlay.classList.add('hidden');
    this.overlay.classList.remove('banner');
  }

  clearEndLeaderboard() {
    if (!this.endLeaderboard) return;
    this.endLeaderboard.innerHTML = '';
    this.endLeaderboard.classList.add('hidden');
  }

  renderEndLeaderboard(rows = []) {
    if (!this.endLeaderboard) return;
    this.endLeaderboard.innerHTML = '';
    rows.forEach((row) => {
      const item = document.createElement('div');
      const statusClass = row.status === 'WINNER' ? 'winner' : row.status === 'LOSER' ? 'loser' : 'draw';
      item.className = `leaderboard-row ${statusClass}`;

      const rank = document.createElement('span');
      rank.className = 'leaderboard-rank';
      rank.textContent = `#${row.rank}`;

      const identity = document.createElement('div');
      identity.className = 'leaderboard-identity';
      const name = document.createElement('strong');
      name.textContent = row.name || 'Player';
      const symbol = document.createElement('span');
      symbol.textContent = row.symbol ? `Symbol ${row.symbol}` : '';
      identity.append(name, symbol);

      const status = document.createElement('span');
      status.className = 'leaderboard-status';
      status.textContent = row.status || '';

      item.append(rank, identity, status);
      this.endLeaderboard.appendChild(item);
    });
    this.endLeaderboard.classList.toggle('hidden', rows.length === 0);
  }

  showGameEndedBanner({ outcome, winnerName, loserName } = {}) {
    this.showOverlay({
      title: 'Game Ended',
      message: outcome === 'win'
        ? `Winner: ${winnerName || 'Player'} · Loser: ${loserName || 'Player'}`
        : 'Draw · Both players finished level',
      showSpinner: false,
    });
    this.overlay.classList.add('banner');
  }

  showResult({ title, summary }) {
    this.resultTitle.textContent = title;
    this.resultSummary.textContent = summary;
    this.resultModal.classList.remove('hidden');
  }

  hideResult() {
    this.resultModal.classList.add('hidden');
  }

  toast(message, duration = 2500) {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      this.toastEl.className = 'toast';
      document.body.appendChild(this.toastEl);
    }
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastEl.classList.remove('show');
    }, duration);
  }

  onMovePlaced(symbol) {
    // Ensure context is resumed before playing.
    audioManager.ensureContextReady()?.catch?.(() => {});
    const now = Date.now();
    if (now - this.lastMoveSoundAt < 150) {
      return; // debounce overlapping plays
    }
    this.lastMoveSoundAt = now;
    audioManager.play(symbol === 'X' ? 'xPlace' : 'oPlace');
  }

  onGameEnded({ outcome, isLocalWinner }) {
    audioManager.ensureContextReady()?.catch?.(() => {});
    audioManager.stopMusicForGameEnd();
    if (outcome !== 'win') return;
    audioManager.play(isLocalWinner ? 'gameWon' : 'gameLost');
  }

  toggleAudio(muted) {
    audioManager.setMuted(muted);
  }

  stopTimerWarning() {
    audioManager.stopTimerWarning();
  }

  startTimerWarning() {
    audioManager.startTimerWarning();
  }

  // End screen helpers (overlay-driven)
  showEndScreen({ outcome, rows = [] } = {}) {
    this.showOverlay({
      title: 'Match Results',
      message: outcome === 'draw' ? 'Final leaderboard · Draw' : 'Final leaderboard',
      showSpinner: false,
    });
    this.overlay.classList.add('results');
    this.renderEndLeaderboard(rows);
  }

  updateEndScreenTimer(seconds) {
    if (Number.isFinite(seconds)) {
      this.overlayMessage.textContent = `Final leaderboard · ${seconds}s`;
    }
  }

  updateEndScreenMessage(message) {
    this.overlayMessage.textContent = message;
  }
}

export default UIManager;
