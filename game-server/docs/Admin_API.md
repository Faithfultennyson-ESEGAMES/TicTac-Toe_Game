# ESEGAMES Game Server API Documentation

This document provides a comprehensive overview of the ESEGAMES Game Server, including session management, real-time gameplay, webhook integration, and administrative APIs.

---

## 1. Game Session Management (HTTP)

### `POST /start`

Initiates a new game session. This is the entry point for creating a playable match.

**Authentication:**

This endpoint is protected. You must provide the `DLQ_PASSWORD` from your `.env` file as a Bearer token in the `Authorization` header.

`Authorization: Bearer <your_dlq_password>`

-   **Request Body (optional):**
    -   `turn_duration_sec` (number): The duration of each turn in seconds. Defaults to `10` if not provided.
-   **Response (201 Created):**
    -   `session_id` (string): The unique identifier for the new session.
    -   `join_url` (string): The fully qualified URL that clients use to connect to the session's real-time socket endpoint.
    -   `signature` (string): An HMAC-SHA256 signature of the `session_id` and `join_url` to prevent tampering.

**Example Request:**

```bash
curl -X POST http://localhost:5500/start \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <your_dlq_password>" \
     -d '{"turn_duration_sec": 15}'
```

**Example Response:**

```json
{
  "session_id": "d2c1ba68-ab40-46b5-9651-b48ed4cb8069",
  "join_url": "http://example.com/session/d2c1ba68-ab40-46b5-9651-b48ed4cb8069/join",
  "signature": "eda297d1aa3c549eba1525d72dfd44ae5d4bf15f460df6b3df3b468c504536d5"
}
```

---

### Step-by-Step Guide: Verifying the `/start` Response Signature

To ensure the `join_url` has not been tampered with, the client should verify the `signature`. This process must be followed exactly.

1.  **Isolate Payload and Signature:** From the JSON response, separate the signature from the data that was signed.
    -   **Signature:** `eda297d1aa3c549eba1525d72dfd44ae5d4bf15f460df6b3df3b468c504536d5`
    -   **Signed Data:** `session_id` and `join_url`.

2.  **Construct the Canonical String:** Create a new object containing **only** the `session_id` and `join_url` fields from the response. Then, convert this new object into a JSON string without any extra whitespace.

    ```javascript
    const payloadToVerify = {
      session_id: "d2c1ba68-ab40-46b5-9651-b48ed4cb8069",
      join_url: "http://example.com/session/d2c1ba68-ab40-46b5-9651-b48ed4cb8069/join"
    };

    const canonicalString = JSON.stringify(payloadToVerify);
    // The string will be:
    // '''{"session_id":"d2c1ba68-ab40-46b5-9651-b48ed4cb8069","join_url":"http://example.com/session/d2c1ba68-ab40-46b5-9651-b48ed4cb8069/join"}'''
    ```

3.  **Recalculate the Signature:** Use the `HMAC_SECRET` (which must be shared securely with the client) to create a new HMAC-SHA256 signature from the `canonicalString` you created in Step 2.

    ```javascript
    const crypto = require('crypto');
    const HMAC_SECRET = 'your-shared-hmac-secret'; // Must match the server's .env

    const computedSignature = crypto.createHmac('sha256', HMAC_SECRET)
                                    .update(canonicalString)
                                    .digest('hex');
    ```

4.  **Compare Signatures:** Use a constant-time comparison function to check if your `computedSignature` matches the `signature` from the original response. This is critical to prevent timing attacks.

    ```javascript
    const receivedSignature = "eda297d1aa3c549eba1525d72dfd44ae5d4bf15f460df6b3df3b468c504536d5";

    const areSignaturesEqual = crypto.timingSafeEqual(
      Buffer.from(computedSignature),
      Buffer.from(receivedSignature)
    );

    if (areSignaturesEqual) {
      console.log("✅ Signature is valid.");
    } else {
      console.error("❌ Invalid signature!");
    }
    ```

---

## 2. Real-Time Gameplay (Socket.IO)
(Sections for Socket.IO events remain the same)

---

## 3. Webhook Integration Guide

The server can dispatch real-time events to external services via webhooks.

### Endpoints & Security

-   **Endpoints:** The server sends `POST` requests to all comma-separated URLs defined in the `.env` variable `WEBHOOK_ENDPOINTS`.
-   **Signature:** Every webhook request includes a `X-Signature` header, which is a SHA-256 HMAC digest of the raw request body, signed with the `HMAC_SECRET` from your `.env` file.

### Delivery & Retry Logic

-   **Success:** A `2xx` HTTP status code from your endpoint is considered a successful delivery.
-   **Permanent Failure:** A `4xx` status code indicates a permanent failure. The webhook is immediately moved to the Dead Letter Queue (DLQ).
-   **Retryable Failure:** A `5xx` status code or a network error triggers a retry mechanism.

---

### Step-by-Step Guide: Verifying Webhook & DLQ Signatures

Any service receiving webhooks (including the matchmaking callback) or resending items from the DLQ must verify the `X-Signature` header.

1.  **Get the Raw Body and Signature:**
    -   **Signature:** Get the value from the `X-Signature` HTTP header.
    -   **Raw Body:** You must use the raw, unparsed request body as a string. Many web frameworks (like Express) require middleware to capture this.
    
    *Example (Express.js):*
    ```javascript
    // In your main app setup, before your routes:
    app.use(express.json({
      verify: (req, res, buf, encoding) => {
        req.rawBody = buf.toString(encoding || 'utf-8');
      }
    }));
    ```

2.  **Recalculate the Signature:** Using your `HMAC_SECRET`, calculate the HMAC-SHA256 signature of the `rawBody` string.

    ```javascript
    const crypto = require('crypto');
    const HMAC_SECRET = process.env.HMAC_SECRET; // Must match the server's .env
    
    // In your route handler:
    const rawBody = req.rawBody;
    const computedSignature = crypto.createHmac('sha256', HMAC_SECRET)
                                    .update(rawBody)
                                    .digest('hex');
    ```

3.  **Compare Signatures:** Use a constant-time comparison function to check if your `computedSignature` matches the signature from the header.

    ```javascript
    const receivedSignature = req.get('X-Signature'); // or req.headers['x-signature']

    const areSignaturesEqual = crypto.timingSafeEqual(
      Buffer.from(computedSignature),
      Buffer.from(receivedSignature)
    );

    if (areSignaturesEqual) {
      console.log("✅ Webhook signature is valid.");
      // Process the webhook...
    } else {
      console.error("❌ Invalid webhook signature! Rejecting request.");
      res.status(403).send('Invalid signature.');
    }
    ```

---

## 4. Administrative APIs
(Admin API sections remain the same)

---

## 5. Matchmaking Service Callback

After a session fully concludes, the server sends a final notification to the matchmaking service. This callback is also signed and must be verified using the same webhook verification guide above.

-   **Endpoint:** The server sends a `POST` request to the URL defined in `MATCHMAKING_SERVICE_URL`.
-   **Signature:** The request includes an `X-Signature` header.
-   **Body:** The raw request body is a JSON string representing the final state of the session object.

**Example Callback Body (Final Session State):**

```json
{
  "sessionId": "e1d1b66c-663f-4c78-9f5e-8e4c06e92843",
  "status": "ended",
  "players": [...],
  "board": [...],
  "winState": "win",
  "winnerPlayerId": "p1",
  ...
}
```
