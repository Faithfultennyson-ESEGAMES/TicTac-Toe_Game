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
