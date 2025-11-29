import audioManager from "./audioManager.js";
import UIManager from "./uiManager.js";
import SocketManager from "./socketManager.js";
import { parseQueryParams, buildRejoinPayload } from "./urlParser.js";

const STORAGE_KEY = 'ttt.session';
const generatePlayerId = () => window.crypto?.randomUUID?.() || `player-${Math.random().toString(16).slice(2)}`;

class GameClient {
  constructor() {
    this.ui = new UIManager();
    this.params = parseQueryParams();
    this.localPlayer = {
      id: this.params.playerId || generatePlayerId(),
      name: this.params.name,
      stake: this.params.stake,
    };

    this.session = null;
    this.playerSymbol = null;
    this.lifecycle = 'created';
    this.turnTick = null;
    this.pendingDisconnect = null;
    this.moveLock = false;
    this.isMuted = false;
    this.handlersAttached = false;

    const serverPort = this.params.raw.get('serverPort') || '3001';
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const hostname = window.location.hostname || 'localhost';
    const computedBase = `${protocol}//${hostname}:${serverPort}`;
    this.socketUrl = window.__GAME_SERVER_BASE__ || computedBase;
    this.apiBase = `${this.socketUrl}/api`;
    console.info('[GameClient] socket endpoint', this.socketUrl);

    this.socketManager = new SocketManager({
      url: this.socketUrl,
      authToken: this.params.token,
      connectionCallbacks: {
        onStatusChange: (status, meta) => this.handleConnectionStatus(status, meta),
        onReconnectNeeded: () => this.attemptRejoin(),
      },
    });
  }

  async init() {
    await audioManager.init();
    this.bindUIEvents();

    console.info('[GameClient] socket.io library present', typeof window.io);

    this.ui.showOverlay({
      title: 'Connecting to Lobby',
      message: 'Preparing your game...',
      showSpinner: true,
    });

    const healthOk = await this.probeServerHealth();
    if (!healthOk) {
      console.warn('[GameClient] Server health probe failed');
    }

    try {
      await this.socketManager.connect();
      this.attachSocketHandlers();
      await this.registerPlayer();
      await this.startMatchmakingFlow();
    } catch (error) {
      console.error('Failed to initialise game client', error);
      const reason = error?.message || 'Unknown error';
      this.ui.showOverlay({
        title: 'Connection Failed',
        message: 'Unable to reach the game server (' + reason + '). Please try again.',
        actionLabel: 'Retry',
        actionHandler: () => this.reinitialise(),
        showSpinner: false,
      });
    }
  }

  bindUIEvents() {
    this.ui.bindBoardHandlers((index) => this.handleCellSelection(index));

    document.getElementById('forfeit-btn').addEventListener('click', async () => {
      if (!this.session) return;
      const confirmed = window.confirm('Are you sure you want to forfeit the match?');
      if (!confirmed) return;
      await this.socketManager.forfeit(this.session.sessionId);
    });

    document.getElementById('mute-btn').addEventListener('click', () => {
      this.isMuted = !this.isMuted;
      this.ui.toggleAudio(this.isMuted);
      this.ui.toast(this.isMuted ? 'Audio muted' : 'Audio enabled');
    });

    document.getElementById('result-close-btn').addEventListener('click', () => {
      this.ui.hideResult();
    });

    document.getElementById('result-requeue-btn').addEventListener('click', async () => {
      this.ui.hideResult();
      await this.startMatchmakingFlow();
    });
  }

  async reinitialise() {
    this.ui.hideOverlay();
    this.ui.markWinningCells([]);
    await this.init();
  }

  async registerPlayer() {
    const response = await this.socketManager.registerPlayer({
      id: this.localPlayer.id,
      name: this.localPlayer.name,
      stake: this.localPlayer.stake,
    });

    if (!response?.acknowledged) {
      throw new Error('Registration failed');
    }
  }

  async startMatchmakingFlow() {
    const cachedSession = this.restoreSession();
    if (cachedSession) {
      await this.handleRejoin(cachedSession);
      return;
    }

    this.ui.showOverlay({
      title: 'Finding Match',
      message: 'Joining the matchmaking queue...',
      showSpinner: true,
      actionLabel: 'Cancel',
      actionHandler: async () => {
        await this.socketManager.cancelQueue();
        this.ui.showOverlay({
          title: 'Queue Cancelled',
          message: 'You left the matchmaking queue.',
          showSpinner: false,
          actionLabel: 'Rejoin Queue',
          actionHandler: () => this.startMatchmakingFlow(),
        });
      },
    });

    const response = await this.socketManager.joinQueue({
      id: this.localPlayer.id,
      name: this.localPlayer.name,
      stake: this.localPlayer.stake,
    });

    if (response.status === 'matched') {
      this.handleGameFound(response.session);
    } else if (response.status === 'queued') {
      this.ui.showOverlay({
        title: 'Waiting for Opponent',
        message: `You are in queue (position ${response.position}).`,
        showSpinner: true,
        actionLabel: 'Cancel',
        actionHandler: async () => {
          await this.socketManager.cancelQueue();
          this.ui.showOverlay({
            title: 'Queue Cancelled',
            message: 'You left the matchmaking queue.',
            showSpinner: false,
            actionLabel: 'Rejoin Queue',
            actionHandler: () => this.startMatchmakingFlow(),
          });
        },
      });
    } else if (response.status === 'in-session') {
      this.handleGameFound(response.session);
    }
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
    this.session = { ...session };
    this.session.players = session.players;
    this.playerSymbol = this.resolvePlayerSymbol(session);
    this.lifecycle = 'active';
    this.session.status = 'active';
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
    this.lifecycle = 'active';
    this.ui.updatePlayers(this.session.players);
    this.ui.setCurrentTurn(currentTurn, {});
    this.startTurnTimer(turnExpiresAt);
  }

  handleMoveApplied({ sessionId, board, moves, currentTurn, turnExpiresAt }) {
    if (!this.session || this.session.sessionId !== sessionId) return;
    this.lifecycle = 'active';
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

  handleGameEnded({ sessionId, result, finalState }) {
    if (!this.session || this.session.sessionId !== sessionId) return;
    this.lifecycle = 'completed';
    this.stopTurnTimer();
    this.ui.stopTimerWarning();

    const state = finalState || this.session;
    this.ui.setBoardState(state.board || Array(9).fill(null));
    if (result?.winningLine) {
      this.ui.markWinningCells(result.winningLine);
    }

    const isWinner = result?.winnerSymbol && this.playerSymbol === result.winnerSymbol;
    const title = result?.outcome === 'draw' ? 'Draw Game' : isWinner ? 'Victory!' : 'Defeat';
    const summary = this.describeResult(result);
    this.ui.showResult({ title, summary });
    this.ui.onGameEnded({
      outcome: result?.outcome,
      winnerSymbol: result?.winnerSymbol,
      isLocalWinner: isWinner,
    });

    this.clearPersistedSession();
  }

  handlePlayerDisconnected({ sessionId, symbol, disconnectExpiresAt }) {
    if (!this.session || this.session.sessionId !== sessionId) return;
    this.lifecycle = 'disconnect_pending';
    this.pendingDisconnect = { symbol, disconnectExpiresAt };

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
      this.ui.hideOverlay();
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

    if (status === 'error') {
      this.ui.setConnectionStatus('disconnected', 'Error');
      this.ui.showOverlay({
        title: 'Connection Issue',
        message: 'Attempting to restore connection...',
        showSpinner: true,
      });
    }
  }

  async attemptRejoin() {
    const cached = this.restoreSession();
    if (cached) {
      await this.handleRejoin(cached);
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
        message: 'Previous session not found. Returning to matchmaking.',
        showSpinner: false,
        actionLabel: 'Find Match',
        actionHandler: () => this.startMatchmakingFlow(),
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
        message: 'Unable to load session state. Returning to matchmaking.',
        showSpinner: false,
        actionLabel: 'Find Match',
        actionHandler: () => this.startMatchmakingFlow(),
      });
    }
  }

  handleCellSelection(index) {
    if (!this.session || this.lifecycle === 'completed') {
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
        sessionId: this.session.sessionId,
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

  describeResult(result = {}) {
    if (!result.outcome) return 'Match ended.';
    if (result.outcome === 'draw') return 'Neither player achieved three in a row.';
    if (result.outcome === 'forfeit') {
      if (result.reason === 'disconnect_timeout') return `${result.forfeitedSymbol} did not reconnect in time.`;
      if (result.reason === 'turn_timeout') return `${result.forfeitedSymbol} ran out of time.`;
      return `${result.forfeitedSymbol} forfeited.`;
    }
    if (result.outcome === 'win') return `${result.winnerSymbol} achieved three in a row.`;
    return 'Game concluded.';
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
        this.ui.startTimerWarning();
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

  async probeServerHealth() {
    try {
      const response = await fetch(`${this.apiBase}/status`, { cache: "no-store" });
      if (!response.ok) {
        console.warn('[GameClient] status endpoint responded with', response.status);
        return false;
      }
      const status = await response.json();
      console.info('[GameClient] status probe success', status);
      return true;
    } catch (error) {
      console.error('[GameClient] status probe failed', error);
      return false;
    }
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

export default GameClient;






