# Game Server Admin API

This document outlines the administrative API endpoints for managing the game server. These endpoints are intended for internal use by administrators for maintenance, monitoring, and debugging.

## Authentication

All administrative endpoints are protected and require authentication. To access these endpoints, you must include an `Authorization` header with a Bearer token containing the `DLQ_PASSWORD` from your environment variables.

**Header Example:**
`Authorization: Bearer <your_dlq_password>`

Requests without a valid `Authorization` header will be rejected with a `401 Unauthorized` error.

---

## Session Management

These endpoints provide control over active game sessions.

### 1. List Active Sessions

- **Endpoint:** `GET /admin/sessions/active`
- **Method:** `GET`
- **Description:** Retrieves a list of all game sessions that are currently active (i.e., not in an `ended` state). This is useful for monitoring server load and inspecting ongoing games.
- **Success Response (`200 OK`):**
  ```json
  [
    {
      "sessionId": "b8a8b2d4-e3c3-4e4f-8a0a-1b1b1b1b1b1b",
      "status": "waiting",
      "players": [],
      "created_at": "2023-10-27T18:00:00.000Z"
    },
    {
      "sessionId": "c3c3c3c3-d4d4-4e4f-8a0a-2c2c2c2c2c2c",
      "status": "active",
      "players": [
        { "playerId": "player-1", "symbol": "X" },
        { "playerId": "player-2", "symbol": "O" }
      ],
      "created_at": "2023-10-27T18:05:00.000Z"
    }
  ]
  ```

### 2. Force-End a Session

- **Endpoint:** `POST /admin/sessions/:sessionId/end`
- **Method:** `POST`
- **Description:** Immediately terminates a specific game session. This triggers the complete `endSession` workflow, including logging and firing the `session.ended` webhook. This should be used to manually resolve stuck or problematic games.
- **URL Parameters:**
  - `sessionId` (string, required): The unique identifier of the session to terminate.
- **Success Response (`200 OK`):**
  ```json
  {
    "message": "Session <sessionId> has been forcefully ended."
  }
  ```
- **Error Responses:**
  - `404 Not Found`: If the specified `sessionId` does not correspond to an existing session.
  - `400 Bad Request`: If the session has already been ended.

---

## Dead Letter Queue (DLQ) Management

These endpoints are for inspecting and managing failed webhook deliveries.

### 1. List DLQ Items

- **Endpoint:** `GET /admin/dlq`
- **Method:** `GET`
- **Description:** Retrieves all items currently in the Dead Letter Queue.
- **Success Response (`200 OK`):** Returns an array of DLQ items.

### 2. Get DLQ Item by ID

- **Endpoint:** `GET /admin/dlq/:id`
- **Method:** `GET`
- **Description:** Retrieves a single DLQ item by its unique ID.
- **Success Response (`200 OK`):** Returns the specific DLQ item.

### 3. Resend DLQ Item

- **Endpoint:** `POST /admin/dlq/:id/resend`
- **Method:** `POST`
- **Description:** Attempts to resend a specific webhook from the DLQ. If successful, the item is removed from the queue.
- **Success Response (`200 OK`):**
  ```json
  {
    "message": "Webhook resent successfully"
  }
  ```

### 4. Bulk Delete DLQ Items

- **Endpoint:** `DELETE /admin/dlq`
- **Method:** `DELETE`
- **Description:** Deletes all items from the Dead Letter Queue. This action is irreversible.
- **Success Response (`200 OK`):**
  ```json
  {
    "message": "DLQ cleared successfully"
  }
  ```
