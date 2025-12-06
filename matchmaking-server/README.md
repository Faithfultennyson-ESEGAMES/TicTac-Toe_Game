# Matchmaking Server for ESEGAMES

This Node.js application serves as the central matchmaking service for the ESEGAMES platform. Its primary role is to queue players, form matches, and coordinate with the `game-server` to create game sessions. It maintains a simple state of the player queue and active games using a local JSON file (`db.json`).

## High-Level Workflow

The matchmaking process follows a specific sequence of events:

1.  **Client Connection**: A player's client application connects to this server via Socket.IO.
2.  **Match Request**: The client emits a `request-match` event containing the `playerId` and `playerName`.
3.  **Queuing**: The server adds the player to a queue. If the player is already in an active game, the server simply sends them the existing game information again.
4.  **Match Formation**: When two players are in the queue, the server pairs them and removes them from the queue.
5.  **Session Creation**: The server sends an authorized, server-to-server HTTP request to the `game-server`'s `/start` endpoint to create a new game session. This request is retried on failure.
6.  **Receive Game Details**: The `game-server` responds with a unique `sessionId` and a `join_url` for the newly created game. The matchmaking server verifies this response using a shared HMAC secret.
7.  **Notify Players**: The matchmaking server emits a `match-found` event to both matched players, providing the `join_url`.
8.  **Session Closure**: After the game ends on the `game-server`, the `game-server` sends a `POST /session-closed` webhook back to this matchmaking server.
9.  **State Cleanup**: The matchmaking server validates the webhook's HMAC signature. Upon successful validation, it removes the players from the `active_games` list, making them available for future matches.

---

## Getting Started

Follow these instructions to set up and run the matchmaking server locally.

### Prerequisites

*   [Node.js](https://nodejs.org/) (v16 or later recommended)
*   npm (comes bundled with Node.js)

### 1. Installation

Clone the repository and install the dependencies.

```bash
npm install
```

### 2. Configuration (.env file)

Create a `.env` file in the `matchmaking-server/` directory. This file is critical for configuring the server's behavior and security settings.

```bash
# .env

# The port the matchmaking server will run on.
PORT=3330

# The base URL for the game-server API. This is used to create new sessions.
# Example: http://localhost:3000
GAME_SERVER_URL=http://localhost:3000

# A secret bearer token sent in the 'Authorization' header to the game-server
# when requesting a new session. The game-server must be configured to validate this token.
MATCHMAKING_AUTH_TOKEN=your_strong_secret_auth_token

# A shared secret key used for HMAC-SHA256 signature verification.
# This is used for two purposes:
# 1. Verifying that responses from the game-server's /start endpoint are authentic.
# 2. Verifying that incoming webhooks to /session-closed are from the game-server.
MATCHMAKING_HMAC_SECRET=your_very_strong_hmac_secret

# The maximum number of times to retry creating a session if the game-server is unresponsive.
# Default: 3
MAX_SESSION_CREATION_ATTEMPTS=3

# The delay in milliseconds between session creation retries.
# Default: 1500
SESSION_CREATION_RETRY_DELAY_MS=1500

# Time-to-live for records in the 'ended_games' database. Old records are not automatically pruned.
# Default: 3600000 (1 hour)
DB_ENTRY_TTL_MS=3600000
```

### 3. Running the Server

Once configured, you can start the server with:

```bash
node index.js
```

You should see a confirmation message in your console:
`Matchmaking server listening on http://localhost:3330`

---

## Client Integration Guide

To build a client application that interacts with this server, you must use Socket.IO.

### 1. Connect to the Server

Establish a connection to the matchmaking server's URL.

```javascript
import { io } from "socket.io-client";

// URL should point to your matchmaking server instance
const socket = io("http://localhost:3330");
```

### 2. Request a Match

Once connected, emit a `request-match` event with a payload containing a unique `playerId` and a display `playerName`.

```javascript
const playerDetails = {
    playerId: 'user-12345-abcdef', // A unique, stable identifier for the player
    playerName: 'RizzoTheRat'       // A display name for the player
};

socket.emit('request-match', playerDetails);
```

### 3. Handle Server Responses

Your client should listen for two possible events from the server:

**`match-found`**: This event signifies a successful match. The payload contains the URL the client should use to join the game.

```javascript
socket.on('match-found', (data) => {
    console.log('Match Found!', data);
    // data = { sessionId: "...", join_url: "..." }

    // Your client should now navigate to the join_url
    // or use it to connect to the game-server.
    window.location.href = data.join_url;
});
```

**`match-error`**: This event signifies a failure. This can happen if the server fails to create a game session after multiple retries.

```javascript
socket.on('match-error', (error) => {
    console.error('Matchmaking Error:', error.message);
    // error = { message: "Could not create game session." }

    // Display an appropriate error message to the user.
});
```

---

## Backend API Endpoints

The server exposes one HTTP endpoint for backend-to-backend communication.

### `POST /session-closed`

This endpoint is designed to be called by the `game-server` when a game session has officially ended. This is critical for freeing up players for new matches.

*   **Method**: `POST`
*   **Security**: The endpoint is protected by HMAC signature verification. The caller **must** include an `X-Signature` header containing the HMAC-SHA256 signature of the raw request body, using the shared `MATCHMAKING_HMAC_SECRET`.
*   **Request Body**: A JSON object containing the ID of the session that ended.
    ```json
    {
      "sessionId": "ccdb7fae-68a3-4dac-9e45-92d50299f471"
    }
    ```
*   **Success Response**:
    *   `200 OK`: If the session was found in the `active_games` list and successfully cleared.
    *   `200 OK`: If the session was not found (it may have been cleared by a duplicate webhook already).
*   **Error Response**:
    *   `400 Bad Request`: If the `sessionId` is missing from the request body.
    *   `401 Unauthorized`: If the `X-Signature` header is missing.
    *   `403 Forbidden`: If the `X-Signature` is invalid.

---

## Database (`db.json`)

The server uses a simple file-based database (`db.json`) for state management. It contains three main keys:

*   `queue`: An array of player objects waiting for a match. Players are removed from here as soon as they are paired.
*   `active_games`: An object mapping a `playerId` to their active `sessionId` and `join_url`. This prevents a player from joining multiple games at once.
*   `ended_games`: A log of sessions that have been closed via the webhook. This is for historical purposes and is not used in the active matchmaking logic.
