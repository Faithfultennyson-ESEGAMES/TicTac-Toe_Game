## 0.5.0 (Webhook Dispatcher & DLQ)

### Features

- **Reliable Webhook Dispatcher:** Rebuilt the webhook dispatcher (`src/webhooks/dispatcher.js`) to ensure reliable, at-least-once delivery of all game events.
- **HMAC Signing:** All outgoing webhooks are signed with a `sha256` HMAC signature in the `X-Signature` header for enhanced security and payload integrity verification.
- **Automatic Retries:** The dispatcher now automatically retries sending webhooks on `5xx` server errors or network failures, following a configurable schedule (`RETRY_SCHEDULE_MS`) up to a maximum number of attempts (`MAX_WEBHOOK_ATTEMPTS`).
- **Dead Letter Queue (DLQ):** Webhooks that fail permanently (`4xx` status) or exhaust all retry attempts are moved to a persistent Dead Letter Queue in the `game-server/dlq/` directory for manual inspection and recovery.
- **Secure Admin API:** Implemented a new set of secure endpoints under `/admin/dlq` to manage the DLQ. Access is protected by a password (`DLQ_PASSWORD`).
- **DLQ Management:** The admin API allows operators to list all DLQ items, view the details of a specific item, trigger a manual resend, and securely delete all items from the queue.
- **Robust Configuration:** The dispatcher gracefully handles scenarios where webhook endpoints are not configured, preventing crashes and ensuring game logic continues uninterrupted.

---

## 0.4.0 (Session Logging & TTL)

### Features

- **Session Logging:** Implemented a new logging module (`src/logging/session_logger.js`) to record the entire lifecycle of each game session.
- **Append-Only Event History:** Logs are created at session start and events (e.g., `session.started`, `player.joined`, `move.made`, `session.ended`) are appended in real-time.
- **Persistent Logs:** Session logs are persisted to disk as individual JSON files in the `game-server/logs/` directory.
- **Final Summary:** When a game ends, the log is updated with a `final_summary` containing the `win_state` and `winner_player_id`.
- **Automatic TTL Cleanup:** Log files are automatically deleted from the disk and cleared from memory after a configurable TTL (`SESSION_LOG_TTL_MS`), preventing unbounded disk usage.
- **Error Isolation:** The logging system is designed to be fault-tolerant; any file system errors are logged as warnings without crashing the game server.

---

## 0.3.0 (Core Gameplay & State Machine)

### Features

- **Turn-Based Gameplay:** Implemented the core Tic-Tac-Toe game logic, allowing players to make moves via a `make-move` socket event.
- **State Machine:** The server now manages the full game lifecycle (`pending` -> `active` -> `ended`).
- **Win/Draw Detection:** The game automatically detects win or draw conditions and ends the game accordingly.
- **Turn Timer & Timeouts:** Each turn is timed (default 10s). If a player fails to move, their turn is passed, and a `player.turn_passed` webhook is dispatched.
- **MAX_TURNS Rule:** Added a `MAX_TURNS` environment variable to prevent games from running indefinitely. If the turn limit is reached, the game ends in a draw.
- **Disconnection/Reconnection:** Players can disconnect and reconnect mid-game. A `player-disconnected` webhook is sent on disconnect, and a `player-reconnected` event is sent upon their return.
- **Session Cleanup:** Implemented robust session cleanup to remove all associated data from memory after a game concludes, preventing memory leaks.
- **Game End Events:** When a game finishes, a neutral `game-ended` event is sent to clients, while a detailed `session.ended` webhook (including the winner) is dispatched to backend listeners.

---

## 0.2.0 (Player Join & Game Start)

### Features

- **Socket.IO Integration:** Added a real-time layer with Socket.IO to handle player connections.
- **Player Join:** Implemented a `join` event for players to register in a game session. The payload now includes `playerId` and `playerName`.
- **Game Start:** The game now automatically begins when two players have joined a session, emitting a `game-found` event to both clients.
- **Reconnect Handling:** Players who disconnect can now seamlessly reconnect to their session using the same `playerId`.
- **Lean Webhooks:** The `player.joined` webhook now correctly sends a lean payload containing only the essential player delta information.

---

## 0.1.0 (Initial Implementation)

### Features

- **Session Creation:** Added a `POST /start` endpoint to create new game sessions. This endpoint accepts an optional `turn_duration_sec` and returns a unique `session_id` and a dynamic `join_url`.
- **Webhook Dispatcher:** Implemented a webhook dispatcher that sends a `session.started` event when a new session is created. The webhook payload is signed with an HMAC-SHA256 signature for security.
