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
