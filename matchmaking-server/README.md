
# Matchmaking Server for ESEGAMES

This Node.js application is the central matchmaking service for the ESEGAMES platform. It manages a player queue, forms matches, and communicates with the `game-server` to create game sessions. It maintains a simple state of the player queue and active games using a local JSON file (`db.json`).

## High-Level Workflow

1.  **Client Connection**: A player connects to this server via Socket.IO.
2.  **Match Request**: The client emits a `request-match` event with their `playerId` and `playerName`.
3.  **Queuing**: The player is added to a queue. If two players are present, a match is formed.
4.  **Session Creation**: The server sends a signed, server-to-server `POST` request to the `game-server`'s `/start` endpoint.
5.  **Receive Game Details**: The `game-server` responds with a `sessionId` and a `joinUrl`. This response is verified using a shared HMAC secret.
6.  **Notify Players**: The server emits a `match-found` event to both players, providing the `sessionId` and `joinUrl`.
7.  **Client Redirect**: The clients construct the final game URL using the received data and redirect the players to the game client.
8.  **Session Closure**: After the game ends, the `game-server` sends a `POST /session-closed` webhook back to this server.
9.  **State Cleanup**: This server validates the webhook, removes the players from the active games list, and emits a `session-ended` event to notify the clients they can play again.

---

## Getting Started

### 1. Installation

Clone the repository and install the dependencies.

```bash
npm install
```

### 2. Configuration (`.env` file)

Create a `.env` file in the `matchmaking-server/` directory. This is essential for configuring the server.

```bash
# .env

# Port for the matchmaking server.
PORT=3330

# Base URL for the game-server API (e.g., http://localhost:5500).
GAME_SERVER_URL=http://localhost:5500

# The shared password for authenticating with the game-server's protected endpoints.
# This MUST match the DLQ_PASSWORD in the game-server's .env file.
DLQ_PASSWORD=your_strong_secret_password

# A shared secret for HMAC-SHA256 signature verification.
# This MUST match the HMAC_SECRET in the game-server's .env file.
HMAC_SECRET=your_very_strong_hmac_secret

# --- Optional Settings ---
MAX_SESSION_CREATION_ATTEMPTS=3
SESSION_CREATION_RETRY_DELAY_MS=1500
DB_ENTRY_TTL_MS=3600000
```

### 3. Running the Server

```bash
node index.js
```


---

## Client Integration Guide

Clients must use Socket.IO to connect and interact with this server.

### 1. Connect and Request a Match

```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:3330"); // Your matchmaking server URL

const playerDetails = {
    playerId: 'user-12345-abcdef', // A unique, stable identifier
    playerName: 'RizzoTheRat'      // Display name
};

socket.emit('request-match', playerDetails);
```

### 2. Handle Server Responses

Your client must handle three key events.

**`match-found`**: The server has found a match and created a game session. The payload contains the necessary information to join.

```javascript
socket.on('match-found', (data) => {
    console.log('Match Found!', data);
    // data = { 
    //   sessionId: "d2c1ba68-ab40-46b5-9651-b48ed4cb8069",
    //   joinUrl: "http://game-server:5500/session/d2c1ba68-ab40-46b5-9651-b48ed4cb8069/join"
    // }

    // IMPORTANT: Construct the URL for the game client, passing the details as query parameters.
    const gameClientUrl = new URL('http://localhost:8080/index.html'); // URL to your game client
    gameClientUrl.searchParams.set('joinUrl', data.joinUrl);
    gameClientUrl.searchParams.set('playerId', playerDetails.playerId);
    gameClientUrl.searchParams.set('playerName', playerDetails.playerName);

    // Redirect the user to the game client.
    window.location.href = gameClientUrl.toString();
});
```

**`match-error`**: The server failed to create a game session.

```javascript
socket.on('match-error', (error) => {
    console.error('Matchmaking Error:', error.message);
    // error = { message: "Could not create game session." }
    // Display a "Try again" UI to the user.
});
```

**`session-ended`**: The game has officially concluded. The user is now free to request a new match.

```javascript
socket.on('session-ended', (data) => {
    console.log(`Session ${data.sessionId} has ended.`);
    // data = { sessionId: "..." }

    // Update the UI to allow the user to start a new match search.
});
```

---

## Backend API Endpoints

The server exposes one HTTP endpoint for server-to-server communication.

### `POST /session-closed`

This endpoint is called by the `game-server` when a session ends.

*   **Method**: `POST`
*   **Security**: The caller **must** include an `X-Hub-Signature-256` header containing the HMAC-SHA256 signature of the raw request body, using the shared `HMAC_SECRET`.
*   **Request Body**: The full `session.ended` webhook payload from the game server. The matchmaking server will extract the `sessionId` from this object.

    ```json
    {
      "sessionId": "ccdb7fae-68a3-4dac-9e45-92d50299f471",
      "status": "ended",
      "players": [...],
      "board": [...],
      "winnerPlayerId": "p1",
      // ... and other session fields
    }
    ```
*   **Success Response**: `200 OK`
*   **Error Responses**:
    *   `400 Bad Request`: If `sessionId` is missing.
    *   `401 Unauthorized`: If the signature header is missing.
    *   `403 Forbidden`: If the signature is invalid.
