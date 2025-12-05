# ESEGAMES Game Server API Documentation

This document provides a comprehensive overview of the ESEGAMES Game Server, including session management, real-time gameplay, webhook integration, and administrative APIs.

---

## 1. Game Session Management (HTTP)

### `POST /start`

Initiates a new game session. This is the entry point for creating a playable match.

-   **Request Body (optional):**
    -   `turn_duration_sec` (number): The duration of each turn in seconds. Defaults to `10` if not provided.
-   **Response (201 Created):**
    -   `session_id` (string): The unique identifier for the new session.
    -   `join_url` (string): The fully qualified URL that clients use to connect to the session's real-time socket endpoint.

**Example Request:**

```bash
curl -X POST http://localhost:5500/start \
     -H "Content-Type: application/json" \
     -d '{"turn_duration_sec": 15}'
```

**Example Response:**

```json
{
  "session_id": "a1b2c3d4-e5f6-7890-1234-567890abcdef",
  "join_url": "http://localhost:5500/session/a1b2c3d4-e5f6-7890-1234-567890abcdef/join"
}
```

---

## 2. Real-Time Gameplay (Socket.IO)

Clients connect to the server via Socket.IO to participate in the game.

### `join` (Client to Server)

A client sends this event to join a game session after it has been created.

-   **Payload:**
    -   `session_id` (string): The session to join.
    -   `playerId` (string): The unique identifier for the player.
    -   `playerName` (string): The player's display name.
-   **Server Emits:**
    -   `game-found`: When the second player joins and the game is ready.
    -   `player-reconnected`: If a previously disconnected player rejoins.
    -   `join-error`: If the payload is invalid or the session is not found.

### `game-found` (Server to Client)

Broadcast to all clients in a session when the game is ready to start.

-   **Payload:**
    -   `session_id` (string): The session ID.
    -   `players` (array): An array of player objects (`{ playerId, playerName, symbol }`).
    -   `board` (array): The initial 9-element game board, filled with `null`.
    -   `turn_duration_sec` (number): The turn duration for the session.

### `turn-started` (Server to Client)

Indicates the start of a new turn.

-   **Payload:**
    -   `current_turn_player_id` (string): The `playerId` of the active player.
    -   `expires_at` (string): An ISO 8601 timestamp for when the turn will automatically expire.

### `make-move` (Client to Server)

A client sends this event to place their mark on the board.

-   **Payload:**
    -   `session_id` (string): The session ID.
    -   `playerId` (string): The `playerId` making the move.
    -   `position` (number): The board index (0-8) for the move.
-   **Server Emits:**
    -   `move-applied`: If the move is valid.
    -   `game-ended`: If the move results in a win or draw.
    -   `move-error`: If the move is invalid (e.g., out of turn, position taken).

### `move-applied` (Server to Client)

Broadcast after a valid move is made.

-   **Payload:**
    -   `board` (array): The updated game board state.
    -   `current_turn_player_id` (string): The `playerId` of the next player.

### `game-ended` (Server to Client)

Broadcast when the game concludes.

-   **Payload:**
    -   `session_id` (string)
    -   `win_state` (string): "win" or "draw".
    -   `winner_player_id` (string | null): The `playerId` of the winner, or `null` for a draw.
    -   `board` (array): The final board state.

### `player-disconnected` / `player-reconnected` (Server to Client)

Broadcast when a player's socket connection status changes.

-   **Payload:**
    -   `playerId` (string): The ID of the affected player.

---

## 3. Webhook Integration Guide

The server can dispatch real-time events to external services via webhooks.

### Endpoints & Security

-   **Endpoints:** The server sends `POST` requests to all comma-separated URLs defined in the `.env` variable `WEBHOOK_ENDPOINTS`.
-   **Signature:** Every webhook request includes a `X-Signature` header, which is a SHA-256 HMAC digest of the raw request body, signed with the `HMAC_SECRET` from your `.env` file.

### Signature Verification

To verify a webhook's authenticity, compute the HMAC SHA-256 signature of the received request body using your `HMAC_SECRET` and compare it to the value of the `X-Signature` header.

**Example (Node.js):**

```javascript
const crypto = require('crypto');
const secret = process.env.HMAC_SECRET;
const signature = req.headers['x-signature'];
const body = req.rawBody; // Use the raw, unparsed request body

const expectedSignature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
  // Signature is valid
} else {
  // Signature is invalid, reject the request
}
```

### Event Types & Payloads

Webhooks are sent for the following events:

-   `session.started`
-   `session.ended`
-   `player.disconnected`
-   `player.reconnected`

The payload structure is:

```json
{
  "event_id": "unique-event-uuid",
  "event_type": "session.started", // or other event types
  "session_id": "session-uuid",
  "body": {
    // Payload specific to the event type
  }
}
```

-   **For `session.started` and `session.ended`**, the `body` contains the full session object.
-   **For `player.disconnected` and `player.reconnected`**, the `body` is a lean object: `{ "playerId": "p1", "status": "disconnected" }`.

### Delivery & Retry Logic

-   **Success:** A `2xx` HTTP status code from your endpoint is considered a successful delivery.
-   **Permanent Failure:** A `4xx` status code indicates a permanent failure. The webhook is immediately moved to the Dead Letter Queue (DLQ).
-   **Retryable Failure:** A `5xx` status code or a network error triggers a retry mechanism based on the `.env` variables `MAX_WEBHOOK_ATTEMPTS` and `RETRY_SCHEDULE_MS`. If all retries fail, the event is moved to the DLQ.

---

## 4. Administrative APIs

These endpoints are for administrative use and are protected by a password.

### Authentication

All admin routes under `/admin/*` are protected. You must provide the `DLQ_PASSWORD` from your `.env` file as a Bearer token in the `Authorization` header.

`Authorization: Bearer <your_dlq_password>`

### `POST /admin/sessions/:sessionId/end`

Forcefully ends an active game session.

-   **URL Parameters:**
    -   `sessionId` (string): The session to terminate.
-   **Response:**
    -   `200 OK` with a success message if the session was found and ended.
    -   `404 Not Found` if the session does not exist.

**Example Request:**

```bash
curl -X POST http://localhost:5500/admin/sessions/a1b2c3d4-e5f6/end \
     -H "Authorization: Bearer <your_dlq_password>"
```

### Dead Letter Queue (DLQ) Admin API

The DLQ API allows you to manage failed webhooks.

#### `GET /admin/dlq`

Lists all item IDs currently in the DLQ.

#### `GET /admin/dlq/:id`

Retrieves the full details of a specific DLQ item, including the reason for failure, delivery attempts, and original payload.

#### `POST /admin/dlq/:id/resend`

Attempts to resend a specific DLQ item. If successful, the item is removed from the DLQ.

#### `DELETE /admin/dlq`

Deletes all items from the DLQ. **This is a destructive action.**

-   **Authentication:** Requires both the `Authorization` header and the password in the request body for an additional layer of security.
-   **Body:** `{ "password": "<your_dlq_password>" }`

---

## 5. Session Closure & Matchmaking

After a session concludes and all related webhooks are processed, the server notifies the matchmaking service that the session is officially closed.

-   **Endpoint:** It sends a `POST` request to the `${MATCHMAKING_SERVICE_URL}/session-closed`.
-   **Payload:** Includes details about the session closure.

This ensures the matchmaking service can free up resources or update its state accordingly.
