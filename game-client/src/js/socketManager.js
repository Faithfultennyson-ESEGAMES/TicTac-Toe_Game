import io from "./lib/socket.io.esm.min.js";

class SocketManager {
    constructor({ url, connectionCallbacks }) {
        this.url = url;
        this.socket = null;
        this.callbacks = connectionCallbacks;
        this.reconnectAttempts = 0;
    }

    async connect() {
        if (this.socket && this.socket.connected) {
            return this.socket;
        }

        return new Promise((resolve, reject) => {
            this.socket = io(this.url, {
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
                timeout: 10000,
                transports: ['websocket'],
            });

            this.socket.on('connect', () => {
                this.callbacks.onStatusChange('connected');
                this.reconnectAttempts = 0;
                resolve(this.socket);
            });

            this.socket.on('connect_error', (err) => {
                this.callbacks.onStatusChange('disconnected');
                if (this.reconnectAttempts >= 5) {
                    this.socket.disconnect();
                    reject(new Error('Connection failed after multiple retries'));
                }
            });

            this.socket.on('disconnect', () => {
                this.callbacks.onStatusChange('disconnected');
            });

            this.socket.on('reconnect_attempt', () => {
                this.reconnectAttempts++;
                this.callbacks.onStatusChange('reconnecting');
            });

            this.socket.on('reconnect_failed', () => {
                this.callbacks.onStatusChange('disconnected');
                this.callbacks.onReconnectNeeded();
            });

            this.socket.on('reconnect', () => {
                this.callbacks.onStatusChange('connected');
            });
        });
    }

    on(event, callback) {
        this.socket?.on(event, callback);
    }

    emit(event, payload) {
        return new Promise((resolve, reject) => {
            this.socket?.emit(event, payload, (response) => {
                if (response && response.status === 'ok') {
                    resolve(response.data);
                } else {
                    reject(new Error(response?.error || 'Unknown error'));
                }
            });
        });
    }
}

export default SocketManager;
