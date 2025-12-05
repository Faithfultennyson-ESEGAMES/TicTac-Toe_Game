import ConnectionManager from "./connectionManager.js";

class SocketManager {
  constructor({ url, authToken, connectionCallbacks = {} }) {
    this.url = url;
    this.authToken = authToken;
    this.socket = null;
    this.registeredHandlers = new Map();
    this.connectionManager = new ConnectionManager(connectionCallbacks);
  }

  connect() {
    console.info('[SocketManager] connect() invoked', { url: this.url, hasExisting: !!this.socket });

    if (this.socket) {
      if (this.socket.connected) {
        return Promise.resolve(this.socket);
      }

      return new Promise((resolve) => {
        this.socket.once('connect', () => resolve(this.socket));
        this.socket.connect();
      });
    }

    if (typeof window.io !== 'function') {
      return Promise.reject(new Error('Socket.IO client library not loaded.'));
    }

    this.connectionManager.setStatus('connecting');

    return new Promise((resolve, reject) => {
      this.socket = window.io(this.url, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        auth: this.authToken ? { token: this.authToken } : undefined,
      });

      this._setupCoreListeners();

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Connection timeout'));
      }, 8000);

      const onConnect = () => {
        this.connectionManager.resetBackoff();
        this.connectionManager.setStatus('connected');
        cleanup();
        resolve(this.socket);
      };

      const onError = (error) => {
        console.error('[SocketManager] connect error', error);
        this.connectionManager.setStatus('error', { error });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off('connect', onConnect);
        this.socket.off('connect_error', onError);
        this.socket.off('error', onError);
      };

      this.socket.on('connect_error', onError);
      this.socket.on('error', onError);
      this.socket.once('connect', onConnect);
    });
  }

  _setupCoreListeners() {
    if (!this.socket) {
      return;
    }

    this.socket.on('connect', () => {
      const transport = this.socket.io?.engine?.transport?.name;
      console.info('[SocketManager] connected', { id: this.socket.id, transport });
      this.connectionManager.setStatus('connected');
    });

    this.socket.on('disconnect', (reason) => {
      this.connectionManager.setStatus('disconnected', { reason });
    });

    this.socket.on('reconnect_attempt', (attempt) => {
      this.connectionManager.setStatus('reconnecting', { attempt });
    });

    this.socket.on('reconnect', () => {
      this.connectionManager.resetBackoff();
      this.connectionManager.setStatus('connected');
    });

    this.socket.on('connect_error', (error) => {
      console.error('[SocketManager] connect_error event', error);
      this.connectionManager.setStatus('error', { error });
      this.connectionManager.scheduleReconnect(() => {
        if (this.socket && this.socket.disconnected) {
          this.socket.connect();
        }
      });
    });
  }

  on(event, handler) {
    if (!this.socket) {
      throw new Error('Socket not connected yet');
    }

    this.socket.on(event, handler);
    if (!this.registeredHandlers.has(event)) {
      this.registeredHandlers.set(event, new Set());
    }
    this.registeredHandlers.get(event).add(handler);
  }

  off(event, handler) {
    if (!this.socket) {
      return;
    }
    this.socket.off(event, handler);
    if (this.registeredHandlers.has(event)) {
      this.registeredHandlers.get(event).delete(handler);
    }
  }

  emit(event, payload = {}, callback = () => {}) {
    if (!this.socket) {
      throw new Error('Socket not connected yet');
    }
    this.socket.emit(event, payload, callback);
  }

  registerPlayer(player) {
    return new Promise((resolve) => {
      this.emit('register-player', player, (response) => {
        resolve(response);
      });
    });
  }

  joinQueue(player) {
    return new Promise((resolve) => {
      this.emit('join-queue', player, (response) => {
        resolve(response);
      });
    });
  }

  cancelQueue() {
    return new Promise((resolve) => {
      this.emit('cancel-queue', (response) => {
        resolve(response);
      });
    });
  }

  makeMove(payload) {
    return new Promise((resolve) => {
      this.emit('make-move', payload, (response) => {
        resolve(response);
      });
    });
  }

  forfeit(sessionId) {
    return new Promise((resolve) => {
      this.emit('forfeit', { sessionId }, (response) => {
        resolve(response);
      });
    });
  }

  rejoinSession(payload) {
    return new Promise((resolve) => {
      this.emit('rejoin-session', payload, (response) => {
        resolve(response);
      });
    });
  }

  disconnect() {
    if (this.socket) {
      this.registeredHandlers.forEach((handlers, event) => {
        handlers.forEach((handler) => this.socket.off(event, handler));
      });
      this.socket.disconnect();
      this.socket = null;
      this.registeredHandlers.clear();
    }
  }
}

export default SocketManager;