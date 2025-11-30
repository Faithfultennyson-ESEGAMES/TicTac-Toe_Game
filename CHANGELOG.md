## 0.1.0 (Initial Implementation)

### Features

- **Session Creation:** Added a `POST /start` endpoint to create new game sessions. This endpoint accepts an optional `turn_duration_sec` and returns a unique `session_id` and a dynamic `join_url`.
- **Webhook Dispatcher:** Implemented a webhook dispatcher that sends a `session.started` event when a new session is created. The webhook payload is signed with an HMAC-SHA256 signature for security.
