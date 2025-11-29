### Game Server Summary (`summary_server.md`)

#### 1. Entry Points and Startup Flow

*   **Main entry point:** `game-server/src/server.js`.
*   It uses `Express.js` to create an HTTP server and `Socket.io` for WebSocket communication.
*   **Startup sequence:**
    1.  Loads environment variables from `.env`.
    2.  Initializes `express` and `socket.io`.
    3.  Instantiates services:
        *   `GameStateStore`: In-memory storage for all game sessions.
        *   `TimerManager`: Manages turn timers and disconnect timers.
        *   `MatchQueue`: A simple queue for players waiting for a match.
        *   `Matchmaker`: Pairs players from the queue to create a new session.
        *   `GameEngine`: Contains the core game logic for handling moves, timeouts, and finishing games.
    4.  An API router is created at `/api` using `game-server/src/routes/api.js`.
    5.  A root `/` endpoint provides a status message.
    6.  The main `socket.io` connection handler listens for new client connections.
    7.  The server starts listening on the port defined in `gameConfig.server.port` (defaults to 3001).

#### 2. Session Creation & Matchmaking

*   Clients connect via WebSocket and can emit a `join-queue` event.
*   The `Matchmaker` (`src/matchmaking/matchmaker.js`) adds the player to a queue.
*   When two players are in the queue, `matchmaker` emits a `match-found` event.
*   The `server.js` listener for `match-found` then:
    1.  Calls `gameEngine.startSession()` which officially starts the game timer and sets the session status to `ACTIVE`.
    2.  Assigns each player to a socket room for the session.
    3.  Emits `game-found` to each player with the initial session state.
*   **API Endpoint for starting a session directly (for testing):** The API router in `src/routes/api.js` exposes a `POST /api/sessions/start` endpoint. This is likely used by the test matchmaking service. It bypasses the queue and directly creates a session.
*   **Returned Fields to Matchmaking:** The `start` endpoint returns a JSON object containing `sessionId`, and a `join_url` (which seems to be constructed on the fly but isn't a primary part of the core game flow, more for the test harness). The main fields are `sessionId`, `status`, `players`, `board`, etc.

#### 3. WebSocket Message Types and Game Loop

*   **Connection:** `connection` - A client connects.
*   **Registration:** `register-player` - A client can send its ID and name. If not sent, the socket ID is used as the player ID.
*   **Queueing:**
    *   `join-queue` - Client requests to join the matchmaking queue.
    *   `cancel-queue` - Client requests to leave the queue.
*   **Game Events (Emitted by Server):**
    *   `game-found` - Sent to both players when a match is made. Contains initial game state.
    *   `turn-started` - Announces whose turn it is and when it expires.
    *   `move-applied` - Sent after a valid move, providing the updated board state.
    *   `game-ended` - Announces the game is over and provides the final result.
    *   `player-rejoined`: Notifies clients that a player has reconnected.
    *   `player-disconnected`: Notifies clients that a player has disconnected.
*   **Client Actions:**
    *   `make-move` - A player submits a move (`{ sessionId, position }`). The server validates it and broadcasts the result.
    *   `forfeit` - A player gives up.
    *   `rejoin-session` - A player attempts to reconnect to an ongoing session.

#### 4. Disconnect/Reconnect Handling

*   **Disconnect:**
    1.  When a player's socket emits `disconnect`, the server marks the player as `connected: false` in the `GameStateStore`.
    2.  The session status is set to `DISCONNECT_PENDING`.
    3.  A **disconnect timer** is started (`gameConfig.timers.disconnectTimer`, default 5 seconds).
    4.  The server emits `player-disconnected` to the other player.
    5.  If the timer expires, `gameEngine.forfeitSession` is called, and the disconnected player loses.
*   **Reconnect:**
    1.  A client can emit `rejoin-session` with `{ sessionId, playerId }`.
    2.  The server validates that the player belongs to that session.
    3.  If valid, it clears the disconnect timer, marks the player as `connected: true`, and sets the session status back to `ACTIVE`.
    4.  It emits `player-rejoined` to notify the other client.

#### 5. Scoring and End-of-Game Flow

*   The `GameEngine` determines the end of a game. This can happen in three ways:
    1.  **Win:** `validation.checkWin()` detects a winning line after a move.
    2.  **Draw:** `validation.checkDraw()` detects the board is full with no winner.
    3.  **Forfeit:** A player forfeits, or a timer (turn or disconnect) expires.
*   `gameEngine.finishSession()` is called to finalize the game.
*   It sets the session `status` to `COMPLETED` and records the `result` (outcome, winner, etc.).
*   It emits `game-ended` to all players in the session room with the final state.
*   **Scoring:** The `GameStateStore` calculates stakes and potential payouts when a session is created (`calculateStakes` helper). However, the final winner determination is purely based on game rules (win/draw/forfeit). The rules state the winner is not sent to the client, but the code in `server.js` *does* send the final state including the result to the client via the `game-ended` event. This is a potential inconsistency.

#### 6. Current Logging Model

*   **Logger:** A `winston`-based logger is used (`src/utils/logger.js`).
*   It logs to both the console and to files in the `logs/` directory (configurable).
*   **Game Logs:** After a session is completed, `gameEngine.finishSession()` calls `logger.writeGameLog()`.
*   This writes a JSON file named `game-<sessionId>-<timestamp>.json` into the `logs/` directory.
*   **Log Content:** The file contains the final `result`, `players`, `moves`, `stakes`, and `metadata` of the session. It does not seem to follow the append-only event model described in the requirements. It's a single dump at the end of the game.

#### 7. Webhook/DLQ Logic

*   **Webhook Dispatch:** After a game ends, `gameEngine.finishSession` calls `apiClient.reportGameResult`.
*   `apiClient.js` (`src/utils/apiClient.js`) contains a function to POST the game result to an external endpoint (`process.env.REACT_APP_RESULT_ENDPOINT`).
*   There is **no evidence** of the following features mentioned in the rules:
    *   Webhook signing (HMAC).
    *   Multiple webhook endpoints.
    *   Retry logic (MAX_WEBHOOK_ATTEMPTS, RETRY_SCHEDULE).
    *   A Dead Letter Queue (DLQ) or any associated API endpoints (`/dlq`).
*   The current implementation is a simple, single "fire-and-forget" POST request. If it fails, the error is logged, but the result is lost.

#### 8. Known Bugs or Inconsistencies

1.  **Staking Logic:** The code still contains logic for calculating stakes (`calculateStakes`, `houseFee`) and includes `stake` fields in player objects. The rules state this is deprecated and should be ignored/removed.
2.  **Winner Sent to Client:** The product requirements state not to send the winner to the game clients. However, the `game-ended` socket event sends the `finalState`, which includes the `result` object containing the winner.
3.  **Logging Model vs. Requirements:** The current logging is a single file dump at the end of the session. It does not match the required append-only event model (`events[]` array, `event_I'd`, `event_type`, etc.).
4.  **Missing Webhook Features:** The entire webhook dispatcher system (signing, retries, DLQ) is missing from the implementation. It's just a simple API call.
5.  **Player joining multiple sessions:** The code has a `playerHasActiveSession` check in `gameState.js` and uses it in `server.js` when a player tries to `join-queue`. This seems to correctly prevent a player from joining the queue if they are already in a session. This appears to be handled correctly.
6.  **Inconsistent environment variable name**: The webhook endpoint is named `REACT_APP_RESULT_ENDPOINT`, which is a convention for React apps to expose variables to the front-end. This is a server-side setting and should probably be something like `GAME_RESULT_WEBHOOK_URL`.
