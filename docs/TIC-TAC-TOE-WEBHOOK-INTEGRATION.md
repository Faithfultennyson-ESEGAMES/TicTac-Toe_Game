# Tic-Tac-Toe Webhook Integration Guide

Final pre-release webhook contract for the Ready-gated lifecycle, optional whole-session lifetime guard, and standardized `session.closed` delivery.

## 1. Final lifecycle naming

The final event names are intentionally aligned with what the lifecycle actually means:

```text
session.created
= POST /start succeeded
= the session/lobby exists
= gameplay has NOT started yet

session.started
= two players are present
= both players are Ready
= session transitions pending -> active
= actual gameplay starts
```

This replaces the earlier pre-release naming:

```text
OLD pre-release name        FINAL name
-----------------------     ----------------
session.started (created) -> session.created
game.started              -> session.started
```

The old `game.started` webhook is no longer emitted. This is a pre-release contract correction so external integrations can use the natural meaning of `session.started` for a fully started match.

The Socket.IO client event `game-found` is unchanged; this document covers outbound HTTP webhooks.

## 2. Canonical webhook protocol

The standard webhook protocol is the official integration contract for all outbound HTTP events from the game server.

Every webhook request is:

- HTTP `POST`
- `Content-Type: application/json`
- JSON request body containing the event payload directly; there is no outer `{ eventType, body }` wrapper
- signed with HMAC-SHA256 using the shared `HMAC_SECRET`

Standard headers:

```text
X-Event-Id: <unique UUID for this delivery>
X-Event-Type: <event type>
X-Hub-Signature-256: <hex HMAC-SHA256 signature>
```

The signature is calculated over the exact raw JSON request body:

```text
hex(HMAC_SHA256(HMAC_SECRET, rawRequestBody))
```

Receivers should verify `X-Hub-Signature-256` against the raw request body before parsing or processing the event.

## 3. Environment configuration

### Standard webhook destinations

```env
WEBHOOK_ENDPOINTS=https://example.com/game-webhook
```

Multiple destinations may be configured as a comma-separated list:

```env
WEBHOOK_ENDPOINTS=https://one.example.com/webhook,https://two.example.com/webhook
```

### Matchmaking/session-close destination

```env
MATCHMAKING_SERVICE_URL=https://example.com/game-webhook
```

`MATCHMAKING_SERVICE_URL` uses the same official webhook protocol as `WEBHOOK_ENDPOINTS`:

- same direct JSON body format
- same HMAC-SHA256 algorithm
- same `X-Event-Id`
- same `X-Event-Type`
- same `X-Hub-Signature-256`

A developer does not need a dedicated matchmaking callback route. The same URL may be used for both settings:

```env
WEBHOOK_ENDPOINTS=https://example.com/game-webhook
MATCHMAKING_SERVICE_URL=https://example.com/game-webhook
```

At session termination that endpoint may receive both:

```text
X-Event-Type: session.ended
X-Event-Type: session.closed
```

The JSON bodies of `session.ended` and `session.closed` are the same final session object. They are separate deliveries and have different `X-Event-Id` values.

If `MATCHMAKING_SERVICE_URL` is not configured, the standard `session.ended` webhook still contains the complete final session state.

## 4. Event lifecycle

A normal Ready-gated match looks like this:

```text
POST /start
    ↓
session.created
    ↓
player.joined
    ↓
player.joined
    ↓
player.ready
    ↓
player.ready
    ↓
pending -> active
    ↓
session.started
    ↓
gameplay / turns
    ↓
session.ended
    ↓
session.closed   (if MATCHMAKING_SERVICE_URL is configured)
```

`session.started` is emitted exactly once at the pending -> active transition. Delayed or repeated Ready requests are idempotent and do not emit another `session.started`.

## 5. Event reference

### `session.created`

Sent to every configured `WEBHOOK_ENDPOINTS` destination when `POST /start` successfully creates a new session.

It does not mean gameplay has begun.

Example body:

```json
{
  "sessionId": "2b393574-ef65-4ea0-a05a-6121a65c38f9",
  "status": "pending",
  "players": [],
  "board": [null, null, null, null, null, null, null, null, null],
  "turnDurationSec": 10,
  "createdAt": "2026-09-03T00:00:00.000Z",
  "expiresAt": null,
  "startedAt": null,
  "currentTurnPlayerId": null,
  "winState": null,
  "winnerPlayerId": null,
  "turnCount": 0
}
```

```text
X-Event-Type: session.created
```

---

### `player.joined`

Sent when a player successfully joins a session for the first time.

```json
{
  "sessionId": "2b393574-ef65-4ea0-a05a-6121a65c38f9",
  "playerId": "player-123",
  "playerName": "Player One",
  "status": "joined"
}
```

```text
X-Event-Type: player.joined
```

---

### `player.ready`

Sent when a player's Ready state is first accepted by the server.

Ready is server-authoritative and idempotent. Retransmitted Ready requests do not create duplicate readiness state.

```json
{
  "sessionId": "2b393574-ef65-4ea0-a05a-6121a65c38f9",
  "playerId": "player-123",
  "status": "ready"
}
```

```text
X-Event-Type: player.ready
```

---

### `session.started`

Sent exactly once when both players are Ready and the server changes the session from `pending` to `active`.

This is the authoritative webhook indicating that the real match has begun.

Example body:

```json
{
  "sessionId": "2b393574-ef65-4ea0-a05a-6121a65c38f9",
  "status": "active",
  "startedAt": "2026-09-03T00:00:12.450Z",
  "currentTurnPlayerId": "player-123",
  "players": [
    {
      "playerId": "player-123",
      "playerName": "Player One",
      "symbol": "X",
      "ready": true
    },
    {
      "playerId": "player-456",
      "playerName": "Player Two",
      "symbol": "O",
      "ready": true
    }
  ]
}
```

```text
X-Event-Type: session.started
```

---

### `player.disconnected`

Sent when a player disconnects from an active game.

```json
{
  "sessionId": "2b393574-ef65-4ea0-a05a-6121a65c38f9",
  "playerId": "player-123",
  "status": "disconnected"
}
```

---

### `player.reconnected`

Sent when an existing player identity successfully reconnects to its session.

```json
{
  "sessionId": "2b393574-ef65-4ea0-a05a-6121a65c38f9",
  "playerId": "player-123",
  "status": "reconnected"
}
```

---

### `player.turn_passed`

Sent when the current player's turn expires and the server passes the turn.

```json
{
  "sessionId": "2b393574-ef65-4ea0-a05a-6121a65c38f9",
  "playerId": "player-123",
  "reason": "timeout"
}
```

---

### `session.ended`

The standard webhook notification that the session is over. It is sent to every configured `WEBHOOK_ENDPOINTS` destination.

The body is the final complete session object. Example:

```json
{
  "sessionId": "2b393574-ef65-4ea0-a05a-6121a65c38f9",
  "status": "ended",
  "players": [
    {
      "playerId": "player-123",
      "playerName": "Player One",
      "socketId": "socket-id",
      "symbol": "X",
      "ready": true
    },
    {
      "playerId": "player-456",
      "playerName": "Player Two",
      "socketId": "socket-id",
      "symbol": "O",
      "ready": true
    }
  ],
  "board": ["X", "X", "X", "O", "O", null, null, null, null],
  "turnDurationSec": 10,
  "createdAt": "2026-09-03T00:00:00.000Z",
  "expiresAt": "2026-09-03T01:00:00.000Z",
  "startedAt": "2026-09-03T00:00:12.450Z",
  "currentTurnPlayerId": "player-123",
  "winState": "win",
  "winnerPlayerId": "player-123",
  "turnCount": 5,
  "turnExpiresAt": "2026-09-03T00:00:45.000Z",
  "endReason": "win"
}
```

A session that ends before gameplay starts has `startedAt: null`, `winState: "none"`, and `winnerPlayerId: null`. Pre-start termination is never reported as a draw or win.

Common `endReason` values include:

```text
win
draw
expired
stale
admin_forced_end
```

```text
X-Event-Type: session.ended
```

---

### `session.closed`

Optional final matchmaking/session-close notification sent to `MATCHMAKING_SERVICE_URL` after `session.ended` processing.

It follows the same official webhook contract:

```text
Content-Type: application/json
X-Event-Id: <unique UUID>
X-Event-Type: session.closed
X-Hub-Signature-256: <HMAC-SHA256 over the raw JSON body>
```

Its JSON body is the same final session object sent by `session.ended`.

## 6. Recommended single-endpoint receiver

A receiver can handle every event on one route:

```js
app.post('/webhook', rawJsonMiddleware, (req, res) => {
  const eventType = req.get('X-Event-Type');
  const eventId = req.get('X-Event-Id');
  const signature = req.get('X-Hub-Signature-256');

  // 1. Verify HMAC against the exact raw request body.
  // 2. Deduplicate using eventId.
  // 3. Parse JSON only after signature verification.
  // 4. Route processing by eventType.

  switch (eventType) {
    case 'session.created':
      break;
    case 'player.joined':
      break;
    case 'player.ready':
      break;
    case 'session.started':
      break;
    case 'player.disconnected':
      break;
    case 'player.reconnected':
      break;
    case 'player.turn_passed':
      break;
    case 'session.ended':
      break;
    case 'session.closed':
      break;
  }

  res.sendStatus(204);
});
```

The receiver should return a `2xx` response after accepting an event.

## 7. Idempotency

Webhook receivers should be idempotent.

Use `X-Event-Id` to detect duplicate delivery attempts. The standard dispatcher retries transient failures, so a receiver may receive the same event delivery again after a timeout or retryable response.

Do not deduplicate using only `sessionId`; one session legitimately emits multiple event types.

Ready itself is also idempotent. A delayed duplicate Ready arriving after the session became active does not create another Ready transition and does not emit another `session.started`.

## 8. Whole-session lifetime behavior

`SESSION_MAX_LIFETIME_MS` is an optional emergency guard for the entire session. `0` disables it, which is the default behavior when the variable is omitted or invalid. With the guard disabled, the Ready lobby has no automatic deadline and can remain pending until both players are Ready or the moderator ends the session.

If a positive value is configured, the lifetime begins at `session.created` time and covers pending and active states. `expiresAt` is `null` when the guard is disabled; otherwise it contains the absolute expiry timestamp.

If the guard expires before gameplay starts, the session ends with:

```text
endReason: "expired"
startedAt: null
winState: "none"
winnerPlayerId: null
```

If it expires after gameplay started, the configured emergency termination path ends the active session and emits the normal final lifecycle notifications. In every case the server sends `session.ended` and, if configured, `session.closed`.

## 9. Final event-name migration note

For anyone who integrated against an earlier pre-release build:

```text
If you previously handled:
  session.started as "session created"
change that handler to:
  session.created

If you previously handled:
  game.started as "actual match began"
change that handler to:
  session.started
```

Do not keep `game.started` in new integrations; the final contract does not emit it.

## 10. Verified behavior

The finalized contract is tested using the HTTPS WebhookCatcher with HMAC verification and with `WEBHOOK_ENDPOINTS` and `MATCHMAKING_SERVICE_URL` able to use the same URL.

The regression suite verifies:

```text
session.created      once for every created session
player.joined        according to actual joins
player.ready         according to accepted Ready states
session.started      exactly once only for the 2/2 Ready active transition
game.started         never emitted
session.ended        once at termination
session.closed       once when matchmaking callback is configured
session.ended body == session.closed body
all HMAC signatures valid
```

Lifetime-guard regression coverage includes disabled lifetime behavior plus pre-start expiry/termination semantics, ensuring a session that never started cannot be reported as a draw or win.
