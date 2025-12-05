import audioManager from "./audioManager.js";
import UIManager from "./uiManager.js";
import SocketManager from "./socketManager.js";
import { parseQueryParams, buildRejoinPayload } from "./urlParser.js";

const STORAGE_KEY = 'ttt.session';

class GameClient {
  constructor() {
    this.ui = new UIManager();
    this.params = parseQueryParams();
    this.localPlayer = {
      id: this.params.playerId,
      name: this.params.playerName,
    };

    this.session = null;
    this.playerSymbol = null;
    this.gameState = 'created'; // created | waiting | playing | ended
    this.turnTick = null;
    this.endScreenTimer = null;
    this.pendingDisconnect = null;
    this.moveLock = false;
    this.handlersAttached = false;

    let socketUrl;
    try {
      socketUrl = new URL(this.params.join_url).origin;
    } catch (e) {
      socketUrl = null;
    }
    this.socketUrl = socketUrl;
    this.apiBase = `${this.socketUrl}/api`;
    console.info('[GameClient] socket endpoint', this.socketUrl);

    this.socketManager = new SocketManager({
      url: this.socketUrl,
      connectionCallbacks: {
        onStatusChange: (status, meta) => this.handleConnectionStatus(status, meta),
        onReconnectNeeded: () => this.attemptRejoin(),
      },
    });
  }

  async init() {
    await audioManager.init();
    this.bindUIEvents();

    if (!this.params.join_url || !this.params.sessionId || !this.localPlayer.id || !this.localPlayer.name) {
      this.ui.showOverlay({
        title: 'Invalid Link',
        message: 'This game link is invalid or incomplete. Please reopen the game from the app.',
        showSpinner: false,
      });
      return;
    }

    this.ui.showOverlay({
      title: 'Connecting to Server',
      message: 'Preparing your game...',
      showSpinner: true,
    });

    try {
      await this.socketManager.connect();
      this.attachSocketHandlers();

      this.gameState = 'waiting';
      this.ui.showOverlay({
        title: 'Connecting to Game',
        message: 'Waiting for the other player to join.',
        showSpinner: true,
      });

      this.socketManager.emit('join', {
        session_id: this.params.sessionId,
        playerId: this.localPlayer.id,
        playerName: this.localPlayer.name,
      });

    } catch (error) {
      console.error('Failed to initialise game client', error);
      const reason = error?.message || 'Unknown error';
      this.ui.showOverlay({
        title: 'Connection Failed',
        message: `Unable to reach the game server (${reason}). Please try again.`,
        actionLabel: 'Retry',
        actionHandler: () => this.reinitialise(),
        showSpinner: false,
      });
    }
  }

  bindUIEvents() {
    this.ui.bindBoardHandlers((index) => this.handleCellSelection(index));

    document.getElementById('result-close-btn').addEventListener('click', () => {
      this.ui.hideResult();
    });
  }

  async reinitialise() {
    this.ui.hideOverlay();
    this.ui.markWinningCells([]);
    await this.init();
  }

  attachSocketHandlers() {
    if (this.handlersAttached) return;
    this.handlersAttached = true;

    this.socketManager.on('game-found', (payload) => this.handleGameFound(payload.state || payload));
    this.socketManager.on('turn-started', (payload) => this.handleTurnStarted(payload));
    this.socketManager.on('move-applied', (payload) => this.handleMoveApplied(payload));
    this.socketManager.on('game-ended', (payload) => this.handleGameEnded(payload));
    this.socketManager.on('player-disconnected', (payload) => this.handlePlayerDisconnected(payload));
    this.socketManager.on('disconnect_timeout', (payload) => this.handleDisconnectTimeout(payload));
  }

  handleGameFound(session) {
    if (session.status === 'ended') {
        this.handleGameEnded({ sessionId: session.sessionId });
        return;
    }

    this.gameState = 'playing';
    this.session = { ...session };
    this.session.players = session.players;
    this.playerSymbol = this.resolvePlayerSymbol(session);
    this.persistSession();

    this.ui.hideOverlay();
    this.ui.markWinningCells([]);
    this.ui.updatePlayers(session.players);
    this.ui.setBoardState(session.board || Array(9).fill(null));
    this.ui.setCurrentTurn(session.currentTurn, { message: 'Game starting...' });

    if (session.turnExpiresAt) {
      this.startTurnTimer(session.turnExpiresAt);
    } else {
      this.ui.updateTimer('--');
    }
  }

  handleTurnStarted({ sessionId, currentTurn, turnExpiresAt }) {
    if (!this.session || this.session.sessionId !== sessionId) return;
    this.session.currentTurn = currentTurn;
    this.session.turnExpiresAt = turnExpiresAt;
    this.ui.updatePlayers(this.session.players);
    this.ui.setCurrentTurn(currentTurn, {});
    this.startTurnTimer(turnExpiresAt);
  }

  handleMoveApplied({ sessionId, board, moves, currentTurn, turnExpiresAt }) {
    if (!this.session || this.session.sessionId !== sessionId) return;
    this.session.board = board;
    this.session.moves = moves;
    this.session.currentTurn = currentTurn;
    this.session.turnExpiresAt = turnExpiresAt;

    const lastMove = moves?.[moves.length - 1];
    if (lastMove) {
      this.ui.onMovePlaced(lastMove.symbol);
    }

    this.ui.setBoardState(board);
    this.ui.setCurrentTurn(currentTurn, {});
    this.startTurnTimer(turnExpiresAt);
  }

  handleGameEnded({ sessionId }) {
    if (this.gameState === 'ended') return;
    this.gameState = 'ended';
    this.stopTurnTimer();
    this.ui.stopTimerWarning();

    this.ui.showEndScreen();
    this.clearPersistedSession();

    let seconds = 0;
    this.ui.updateEndScreenTimer(seconds);

    this.endScreenTimer = setInterval(() => {
        seconds++;
        this.ui.updateEndScreenTimer(seconds);
        if (seconds >= 60) {
            clearInterval(this.endScreenTimer);
            this.ui.updateEndScreenMessage("Session window expired");
        }
    }, 1000);
  }

  handlePlayerDisconnected({ sessionId, symbol, disconnectExpiresAt }) {
    if (!this.session || this.session.sessionId !== sessionId) return;

    if (this.session.players?.[symbol]) {
      this.session.players[symbol] = {
        ...this.session.players[symbol],
        connected: false,
      };
    }

    this.ui.updatePlayers(this.session.players);

    const remaining = this.formatCountdown(disconnectExpiresAt);
    this.ui.toast(`Player ${symbol} disconnected. Forfeit in ${remaining}.`);
  }

  handleDisconnectTimeout({ sessionId }) {
    if (!this.session || this.session.sessionId !== sessionId) return;
    this.ui.toast('Opponent did not return in time.');
  }

  handleConnectionStatus(status) {
    if (status === 'connected') {
      this.ui.setConnectionStatus('connected', 'Connected');
      if (this.gameState === 'waiting') {
         this.ui.showOverlay({
            title: 'Connecting to Game',
            message: 'Waiting for the other player to join.',
            showSpinner: true,
         });
      } else {
        this.ui.hideOverlay();
      }
      return;
    }

    if (status === 'reconnecting') {
      this.ui.setConnectionStatus('connecting', 'Reconnecting...');
      return;
    }

    if (status === 'disconnected') {
      this.ui.setConnectionStatus('disconnected', 'Disconnected');
      this.ui.toast('Connection lost. Attempting to reconnect...');
      this.ui.showOverlay({
        title: 'Connection Lost',
        message: 'Attempting to restore connection...',
        showSpinner: true,
      });
      return;
    }
  }

  async attemptRejoin() {
    const cached = this.restoreSession();
    if (cached) {
      await this.handleRejoin(cached);
    } else {
        // If no session to rejoin, we are stuck.
        this.ui.showOverlay({
            title: 'Link Required',
            message: 'Please use a valid game link to join a session.',
            showSpinner: false,
        });
    }
  }

  async handleRejoin(cachedSession) {
    this.ui.showOverlay({
      title: 'Rejoining Match',
      message: 'Attempting to rejoin your previous session...',
      showSpinner: true,
    });

    const payload = buildRejoinPayload({
      sessionId: cachedSession.sessionId,
      playerId: cachedSession.playerId,
    });

    const response = await this.socketManager.rejoinSession(payload);
    if (!response?.ok) {
      this.clearPersistedSession();
      this.ui.showOverlay({
        title: 'Session Unavailable',
        message: 'Previous session not found or has ended.',
        showSpinner: false,
      });
      return;
    }

    const state = await this.fetchSessionState(payload.sessionId);
    if (state) {
      this.handleGameFound(state);
      this.playerSymbol = response.symbol || this.resolvePlayerSymbol(state);
      this.persistSession();
      this.ui.toast('Successfully rejoined match.');
    } else {
      this.clearPersistedSession();
      this.ui.showOverlay({
        title: 'Session Unavailable',
        message: 'Unable to load session state.',
        showSpinner: false,
      });
    }
  }

  handleCellSelection(index) {
    if (this.gameState !== 'playing') {
      return;
    }
    if (!this.session) {
      return;
    }
    if (this.playerSymbol !== this.session.currentTurn) {
      this.ui.toast('Not your turn yet.');
      return;
    }
    if (Array.isArray(this.session.board) && this.session.board[index]) {
      this.ui.toast('Cell already occupied.');
      this.cellsShake();
      return;
    }
    if (this.moveLock) return;

    this.moveLock = true;
    this.socketManager
      .makeMove({
        session_id: this.session.sessionId,
        playerId: this.localPlayer.id,
        position: index,
      })
      .then((response) => {
        this.moveLock = false;
        if (response?.error) {
          this.ui.toast(this.describeMoveError(response.error));
        }
      })
      .catch(() => {
        this.moveLock = false;
        this.ui.toast('Failed to submit move.');
      });
  }

  resolvePlayerSymbol(session) {
    const { players } = session;
    if (players?.X?.id === this.localPlayer.id) return 'X';
    if (players?.O?.id === this.localPlayer.id) return 'O';
    return null;
  }

  describeMoveError(code) {
    const map = {
      invalid_payload: 'Invalid move payload.',
      session_not_found: 'Session not found.',
      session_not_active: 'Session not active.',
      not_player_turn: "It isn't your turn yet.",
      invalid_position: 'Invalid cell.',
      cell_occupied: 'Cell already occupied.',
      player_not_in_session: 'Player not in session.',
    };
    return map[code] || 'Move rejected.';
  }

  startTurnTimer(turnExpiresAt) {
    this.stopTurnTimer();
    if (!turnExpiresAt) {
      this.ui.updateTimer('--');
      return;
    }

    const expiry = new Date(turnExpiresAt).getTime();
    const tick = () => {
      const remaining = Math.max(0, expiry - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      const minutes = Math.floor(seconds / 60);
      const secs = String(seconds % 60).padStart(2, '0');

      let state = 'normal';
      if (seconds <= 10) {
        state = 'danger';
        this.ui.startTimerWarning();
      } else if (seconds <= 20) {
        state = 'warning';
      } else {
        this.ui.stopTimerWarning();
      }

      this.ui.updateTimer(`${minutes}:${secs}`, state);
      if (remaining <= 0) {
        this.stopTurnTimer();
        this.ui.stopTimerWarning();
      }
    };

    tick();
    this.turnTick = setInterval(tick, 1000);
  }

  stopTurnTimer() {
    clearInterval(this.turnTick);
    this.turnTick = null;
  }

  formatCountdown(expiresAt) {
    const remaining = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    return `${seconds}s`;
  }

  persistSession() {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessionId: this.session.sessionId,
        playerId: this.localPlayer.id,
        symbol: this.playerSymbol,
      }),
    );
  }

  restoreSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      console.warn('Failed to restore session', error);
      return null;
    }
  }

  clearPersistedSession() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  cellsShake() {
    this.ui.boardEl.classList.add('shake');
    setTimeout(() => this.ui.boardEl.classList.remove('shake'), 350);
  }

  async fetchSessionState(sessionId) {
    try {
      const response = await fetch(`${this.apiBase}/session/${sessionId}`);
      if (!response.ok) {
        return null;
      }
      return response.json();
    } catch (error) {
      console.warn('Failed to fetch session state', error);
      return null;
    }
  }
}

export default GameClient;n