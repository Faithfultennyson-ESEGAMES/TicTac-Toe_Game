# ESEGAMES Game Server API Documentation

This document provides a comprehensive overview of the ESEGAMES Game Server, including session management, real-time gameplay, webhook integration, and administrative APIs. All request and response body examples use `camelCase` for property names, which is the standard for this server.

---

## 1. Client-Server Communication

This section details how game clients (e.g., the browser-based client) should communicate with the server. The process involves two main stages: initiating a session via HTTP and then connecting for real-time gameplay via Socket.IO.

### 1.1. Session Initiation (HTTP)

#### `POST /start`

Initiates a new game session. This is the mandatory first step for any game client.

**Authentication:**
This endpoint is protected. The caller (e.g., a matchmaking service) must provide the `DLQ_PASSWORD` from the `.env` file as a Bearer token in the `Authorization` header.

`Authorization: Bearer <your_dlq_password>`

**Request Body (optional):**
-   `turnDurationSec` (number): The duration of each turn in seconds. Defaults to `10` if not provided.

**Success Response (201 Created):**
-   **Header:** `X-Hub-Signature-256: <signature>`
    -   An HMAC-SHA256 signature of the raw JSON response body. This is used to verify the integrity of the response.
-   **Body:**
    -   `sessionId` (string): The unique identifier for the new session.
    -   `joinUrl` (string): The fully qualified URL that clients use to join the session.

**Example Request:**
```bash
curl -X POST http://localhost:5500/start \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <your_dlq_password>" \
     -d '{"turnDurationSec": 15}'
```

**Example Response:**
-   **Headers:**
    ```
    HTTP/1.1 201 Created
    Content-Type: application/json
    X-Hub-Signature-256: 3a9a3b61834259b3d179a3c75a1d10e34c27b3e0c0a3f7c3e5a3b2a1a0c0e1b2
    ```
-   **Body:**
    ```json
    {
      "sessionId": "d2c1ba68-ab40-46b5-9651-b48ed4cb8069",
      "joinUrl": "http://example.com/session/d2c1ba68-ab40-46b5-9651-b48ed4cb8069/join"
    }
    ```

#### Verifying the `/start` Response Signature

The service calling `/start` **must** verify the signature to ensure the `joinUrl` has not been tampered with.

1.  **Get the Raw Body and Signature:**
    -   **Signature:** Get the value from the `X-Hub-Signature-256` HTTP header.
    -   **Raw Body:** You must use the raw, unparsed response body as a string.

2.  **Recalculate the Signature:** Use the `HMAC_SECRET` (which must be shared with the calling service) to create a new HMAC-SHA256 signature from the raw body string.

    ```javascript
    // Node.js Example
    const crypto = require('crypto');
    const HMAC_SECRET = 'your-shared-hmac-secret'; // Must match the server's .env

    // assuming `rawBodyString` is the exact string '{"sessionId":"...","joinUrl":"..."}'
    const computedSignature = crypto.createHmac('sha256', HMAC_SECRET)
                                    .update(rawBodyString)
                                    .digest('hex');
    ```

3.  **Compare Signatures:** Use a constant-time comparison function to check if your `computedSignature` matches the signature from the header.

    ```javascript
    const receivedSignature = response.headers['x-hub-signature-256'];

    const areSignaturesEqual = crypto.timingSafeEqual(
      Buffer.from(computedSignature, 'hex'),
      Buffer.from(receivedSignature, 'hex')
    );

    if (areSignaturesEqual) {
      console.log("✅ Signature is valid.");
    } else {
      console.error("❌ Invalid signature!");
    }
    ```

### 1.2. Real-Time Gameplay (Socket.IO)

Once a session is created, clients connect to the server using Socket.IO for real-time gameplay events.

#### Connecting

Clients should connect to the main server endpoint provided in the `joinUrl`.

#### Emitted Events (Client to Server)

-   `join`: Sent by a player to join a specific game session.
    -   Payload: `{ sessionId: string, playerId: string, playerName: string }`
-   `make-move`: Sent by the current player to make a move on the board.
    -   Payload: `{ sessionId: string, playerId: string, position: number }` (position is 0-8)

#### Received Events (Server to Client)

-   `join-error`: If a player fails to join a session. The client should display an appropriate message to the user based on the error.
    -   Payload: `{ message: string }`
    -   Possible `message` values:
        -   `"Session not found."`: The provided `sessionId` does not correspond to an active session. This can happen if the session ID is incorrect or the session has already ended.
        -   `"Session is full."`: The session already has two players.
-   `waiting-for-player`: After the first player joins, indicating the server is waiting for the second player.
-   `game-found`: When two players have joined and the game is ready to start.
    -   Payload: `{ sessionId: string, players: Array<{ playerId, playerName, symbol }>, board: Array<null|string>, turnDurationSec: number }`
-   `turn-started`: Announces the start of a new turn.
    -   Payload: `{ currentTurnPlayerId: string, expiresAt: string }` (ISO 8601 timestamp)
-   `move-applied`: Confirms a move has been made and updates the game state.
    -   Payload: `{ board: Array<null|string>, currentTurnPlayerId: string }`
-   `move-error`: If a move is invalid. The client should prevent the user from retrying the move and wait for the next turn.
    -   Payload: `{ message: string }`
    -   Possible `message` values:
        -   `"Not your turn."`
        -   `"Invalid position."`
        -   `"Position already taken."`
        -   `"Game is not active."`
-   `game-ended`: When the game finishes (win, draw, or other condition). The client should display a neutral end screen. The actual winner is **only** sent via webhook.
    -   Payload: `{ reason: 'win' | 'draw' | 'stale', board: Array<null|string> }`
-   `player-disconnected`: When a player loses their socket connection.
    -   Payload: `{ playerId: string }`
-   `player-reconnected`: When a player successfully reconnects to a session.
    -   Payload: `{ playerId: string }`

### 1.3. Launching the Game Client

After creating a session via the `POST /start` endpoint, the client application (the user's browser) must be redirected to the game client's URL with the correct query parameters. The game client reads these parameters to connect to the correct session and identify the player.

**Required Query Parameters:**

The client URL must include the following `camelCase` query parameters:

-   `joinUrl` (string, URL-encoded): The fully qualified `joinUrl` returned by the `/start` endpoint. The client uses this to establish a Socket.IO connection with the game server.
-   `playerId` (string): The canonical, unique identifier for the player joining the session.
-   `playerName` (string): The display name for the player (e.g., "Alice").

**Example:**

Suppose your game client is hosted at `https://your-game-client.com/`.

1.  Your matchmaking service calls `POST /start` and receives:
    ```json
    {
      "sessionId": "d2c1ba68-ab40-46b5-9651-b48ed4cb8069",
      "joinUrl": "https://game-server.example.com/session/d2c1ba68-ab40-46b5-9651-b48ed4cb8069/join"
    }
    ```

2.  The player to join has `playerId` = "p1_alice" and `playerName` = "Alice".

3.  Your service must construct the following URL and redirect the user's browser to it. Note that the `joinUrl` value must be URL-encoded.

    **Final URL:**
    ```
    https://your-game-client.com/?joinUrl=https%3A%2F%2Fgame-server.example.com%2Fsession%2Fd2c1ba68-ab40-46b5-9651-b48ed4cb8069%2Fjoin&playerId=p1_alice&playerName=Alice
    ```

Upon loading, the client will parse these parameters, extract the `sessionId` from the `joinUrl`, and automatically attempt to join the game session.

---

## 2. Webhook Integration Guide

The server dispatches real-time game events to external services via webhooks.

### Endpoints & Security

-   **Endpoints:** The server sends `POST` requests to all comma-separated URLs defined in the `.env` variable `WEBHOOK_ENDPOINTS`.
-   **Signature:** Every webhook request includes an `X-Hub-Signature-256` header, which is an HMAC-SHA256 digest of the raw request body, signed with the `HMAC_SECRET` from the `.env` file.

### Delivery & Retry Logic

-   **Success:** A `2xx` HTTP status code is considered a successful delivery.
-   **Permanent Failure:** A `4xx` status code indicates a permanent failure. The webhook is immediately moved to the Dead Letter Queue (DLQ).
-   **Retryable Failure:** A `5xx` status code or a network error triggers a retry mechanism based on `MAX_WEBHOOK_ATTEMPTS` and `RETRY_SCHEDULE_MS`.

### Verifying Webhook Signatures

Any service receiving webhooks **must** verify the `X-Hub-Signature-256` header. The process is identical to verifying the `/start` response signature.

1.  **Get Raw Body & Signature:** Capture the raw request body *before* it is parsed. Get the signature from the `X-Hub-Signature-256` header.
2.  **Recalculate Signature:** Use the shared `HMAC_SECRET` to compute the HMAC-SHA256 of the raw body.
3.  **Compare Signatures:** Use a constant-time comparison. Reject the request if the signatures do not match.

*Example (Express.js):*
```javascript
// Middleware to capture the raw body
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Route handler
app.post('/webhook-handler', (req, res) => {
  const receivedSignature = req.get('X-Hub-Signature-256');
  // ... perform verification logic ...
});
```

### Webhook Event Payloads

All webhook payloads are structured with a root `body` property containing the event details.

-   `session.started`: The full session object when it is created.
-   `session.ended`: The full session object at the end of a game, including `winState` and `winnerPlayerId`.
-   `player.joined`: `{ sessionId, playerId, playerName, status: 'joined' }`
-   `player.disconnected`: `{ sessionId, playerId, status: 'disconnected' }`
-   `player.reconnected`: `{ sessionId, playerId, status: 'reconnected' }`
-   `player.turn_passed`: `{ sessionId, playerId, reason: 'timeout' }`

**Example `session.ended` Webhook Body:**
```json
{
  "sessionId": "ccdb7fae-68a3-4dac-9e45-92d50299f471",
  "status": "ended",
  "players": [
    { "playerId": "p1", "playerName": "Alice", "socketId": null, "symbol": "X" },
    { "playerId": "p2", "playerName": "Bob", "socketId": null, "symbol": "O" }
  ],
  "board": ["X", "O", "X", "O", "X", "O", null, null, "X"],
  "turnDurationSec": 10,
  "createdAt": "2023-10-27T10:00:00.000Z",
  "currentTurnPlayerId": "p2",
  "turnTimerId": null,
  "winState": "win",
  "winnerPlayerId": "p1",
  "turnCount": 7
}
```
---

## 3. Matchmaking Service Integration

### Matchmaking -> Game Server

The matchmaking service is responsible for calling `POST /start` on the game server to create a session. It must follow the authentication and signature verification steps outlined in section 1.1.

### Game Server -> Matchmaking Service (`/session-closed`)

When a game session concludes, the `game-server` sends a final `POST` request to the `MATCHMAKING_SERVICE_URL`. This notifies the matchmaking service that the session is complete.

This callback follows the **standard webhook format**:

-   **Endpoint:** The URL is taken directly from the `MATCHMAKING_SERVICE_URL` environment variable. Ensure this includes the full path (e.g., `http://matchmaker.example.com/api/session-closed`).
-   **Headers:** Includes the `X-Hub-Signature-256` header with the raw HMAC signature.
-   **Body:** The request body is the **entire final session object**, identical to the `session.ended` webhook payload.
-   **Retry Logic:** This is a "fire-and-forget" notification. It is not retried or sent to the DLQ upon failure.

The matchmaking service **must** implement an endpoint that verifies the `X-Hub-Signature-256` header and handles the `camelCase` session object payload.

---

## 4. Administrative APIs

These endpoints are for administrative use and are protected by a password.

**Authentication:**
All admin endpoints require the `DLQ_PASSWORD` to be provided as a Bearer token.

`Authorization: Bearer <your_dlq_password>`

### Dead Letter Queue (DLQ) Management

The DLQ stores webhook events that failed to be delivered after all retry attempts.

#### `GET /admin/dlq`
Lists all items currently in the DLQ.

-   **Response (200 OK):** An array of DLQ items.

**DLQ Item Structure:**
```json
{
  "dlqItemId": "a1b2c3d4-...",
  "failedAt": "2023-10-27T10:15:00.000Z",
  "reason": "Exhausted 3 retry attempts.",
  "endpoint": "https://consumer.example.com/webhook",
  "lastResponseStatus": 503,
  "deliveryAttempts": [
    {
      "attemptId": "e5f6a7b8-...",
      "timestamp": "2023-10-27T10:14:45.000Z",
      "statusCode": 503,
      "error": null
    }
  ],
  "webhookPayload": {
    "eventId": "f0g1h2i3-...",
    "eventType": "session.ended",
    "sessionId": "ccdb7fae-68a3-4dac-9e45-92d50299f471",
    "body": { ... }
  }
}
```

#### `GET /admin/dlq/:id`
Retrieves a single DLQ item by its `dlqItemId`.

-   **Response (200 OK):** The requested DLQ item.
-   **Response (404 Not Found):** If the item does not exist.

#### `POST /admin/dlq/:id/resend`
Attempts to resend a single DLQ item to its original endpoint. If successful, the item is deleted from the DLQ.

-   **Response (200 OK):** `{ "message": "DLQ item resent successfully." }`
-   **Response (400 Bad Request):** `{ "message": "DLQ item resend failed." }`
-   **Response (404 Not Found):** If the item does not exist.

#### `DELETE /admin/dlq`
Deletes all items from the DLQ. This is a bulk operation.

-   **Response (200 OK):** `{ "message": "All DLQ items deleted.", "deletedCount": 42 }`

---

## 5. Configuration (.env)

To run the server, you must create a `.env` file in the `game-server` root directory. This file stores essential configuration variables.

-   `PORT`
    -   **Purpose:** The port on which the HTTP and Socket.IO server will run.
    -   **Default:** `5500`

-   `HMAC_SECRET`
    -   **Purpose:** A long, secret string used to sign and verify all outgoing webhooks and the `/start` endpoint response. This secret must be shared with any service that needs to verify signatures.
    -   **Example:** `your-super-secret-hmac-string`

-   `DLQ_PASSWORD`
    -   **Purpose:** The password used to protect all administrative endpoints (`/admin/*`) and the `/start` endpoint. Passed as a Bearer token.
    -   **Example:** `a-very-strong-admin-password`

-   `WEBHOOK_ENDPOINTS`
    -   **Purpose:** A comma-separated list of URLs to which the server will send all webhook events.
    -   **Example:** `https://api.example.com/webhook,https://another-service.com/events`

-   `MAX_WEBHOOK_ATTEMPTS`
    -   **Purpose:** The maximum number of times the server will attempt to send a webhook before moving it to the DLQ.
    -   **Default:** `3`

-   `RETRY_SCHEDULE_MS`
    -   **Purpose:** A comma-separated list of delays (in milliseconds) for webhook retries. The number of entries should ideally match `MAX_WEBHOOK_ATTEMPTS` - 1.
    -   **Example:** `1000,5000` (Retry after 1s, then after 5s)

-   `MATCHMAKING_SERVICE_URL`
    -   **Purpose:** The full URL (including path) for the matchmaking service's `/session-closed` callback endpoint.
    -   **Example:** `http://localhost:3000/session-closed`

-   `SESSION_LOG_TTL_MS`
    -   **Purpose:** The time-to-live for session log files, in milliseconds. After this duration, the logs are automatically deleted.
    -   **Default:** `3600000` (1 hour)