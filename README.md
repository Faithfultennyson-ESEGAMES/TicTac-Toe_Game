# ESEGAMES Game Server

This repository contains the backend game server for a real-time, turn-based Tic-Tac-Toe game. It is built from scratch in Node.js with Express and Socket.IO.

## Features

- **Session Management:** Create game sessions via a simple REST API.
- **Real-time Gameplay:** Uses Socket.IO for low-latency, turn-based gameplay.
- **Player State:** Supports player join, disconnect, and seamless reconnect.
- **Game Logic:** Includes win/draw detection, turn timers with automatic passing, and a maximum turn limit to prevent indefinite games.
- **Reliable Webhooks:** Dispatches critical game events (like `session.started`, `player.joined`, `session.ended`) to external services via HMAC-signed webhooks.
- **Webhook Resiliency:** Features an automatic retry mechanism for webhook delivery and a Dead Letter Queue (DLQ) for permanent failures.
- **Secure DLQ Admin:** Provides a password-protected REST API to inspect, resend, or delete failed webhooks from the DLQ.
- **Ephemeral Session Logging:** Creates a detailed, append-only log for each session, which is automatically deleted after a configurable time-to-live (TTL) to manage disk space.

---

## Folder Structure

```
.
├── game-server/       # The Node.js (Express + Socket.IO) backend application.
└── game-client/       # A simple HTML and vanilla JavaScript client for testing.
```

---

## Setup and Running the Project

### 1. Prerequisites

- Node.js (v18 or later recommended)
- npm

### 2. Installation

Install dependencies for both the server and the client.

```bash
# Install server dependencies
cd game-server
npm install

# Go back to root and install client dependencies
cd ../game-client
npm install
```

### 3. Environment Configuration

Before running the server, you must configure your environment variables.

1.  Navigate to the `game-server` directory.
2.  Create a `.env` file by copying the example: `cp .env.example .env`
3.  Edit the `.env` file and provide values for the variables. See the **Environment Variables** section below for details.

### 4. Running the Application

```bash
# Run the game server (from the game-server/ directory)
npm start
```

The server will start on the port specified in your `.env` file (defaulting to 3000).

The `game-client` can be opened directly in a web browser by opening the `game-client/index.html` file.

---

## Environment Variables (`game-server/.env`)

| Variable                 | Description                                                                                             | Example                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `PORT`                   | The port on which the Express server will run.                                                          | `3000`                                     |
| `MAX_TURNS`              | The maximum number of turns before a game automatically ends in a draw.                                 | `15`                                       |
| `HMAC_SECRET`            | A secret key used to sign outgoing webhooks with an HMAC-SHA256 signature.                              | `your-super-secret-key`                    |
| `WEBHOOK_ENDPOINTS`      | A comma-separated list of URLs to which game event webhooks will be sent.                               | `http://localhost:4000/webhook`            |
| `MAX_WEBHOOK_ATTEMPTS`   | The total number of times to try sending a webhook (1 initial + 2 retries = 3 total).                 | `3`                                        |
| `RETRY_SCHEDULE_MS`      | A comma-separated list of delays (in milliseconds) for webhook retry attempts.                          | `1000,5000`                                |
| `SESSION_LOG_TTL_MS`     | The time-to-live for session log files on disk, in milliseconds. Defaults to 1 hour.                    | `3600000`                                  |
| `DLQ_PASSWORD`           | The password required to access the Dead Letter Queue admin endpoints (`/admin/dlq`).                   | `your-secure-dlq-password`                 |

---

## Core Concepts

### WebSocket Lifecycle

The client and server communicate over Socket.IO for real-time game events.

1.  **`join`**: A player connects and sends a `join` event with their `sessionId`, `playerId`, and `playerName`.
2.  **`game-found`**: Once two players have joined, the server sends this event to both, signaling the start of the game.
3.  **`turn-started`**: The server informs the current player that their turn has begun and starts a timer.
4.  **`move-applied`**: After a valid move, the server broadcasts the updated game state to both players.
5.  **`game-ended`**: When the game is over (win, draw, or timeout), the server sends this event to both players. The client is responsible for displaying a neutral end screen.

### Webhook System

The server dispatches important, non-gameplay events to external services via webhooks for purposes like analytics, matchmaking, or data warehousing.

- **Events**: `session.started`, `player.joined`, `player.disconnected`, `player.reconnected`, `session.ended`.
- **Security**: All webhooks are `POST` requests with a JSON body and an `X-Signature` header containing the `sha256` HMAC of the raw body.
- **DLQ**: If a webhook fails to be delivered after all retry attempts, it is stored in the `game-server/dlq/` directory. You can use the `/admin/dlq` endpoints with your `DLQ_PASSWORD` to manage these failed events.
