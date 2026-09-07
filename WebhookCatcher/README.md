# Tic Tac Toe Webhook Catcher

A small integration-test service for inspecting and verifying every outbound Tic Tac Toe server webhook.

## Public test mapping

- Catcher UI: `https://app2.solarcal.xyz`
- Local catcher: `http://localhost:3101`
- Dispatcher endpoint: `https://app2.solarcal.xyz/webhook`
- Matchmaking session-closed endpoint: `https://app2.solarcal.xyz/session-closed`
- Game server under test: `https://app1.solarcal.xyz`

## What it captures

The `/webhook` endpoint records dispatcher events including:

- `session.created` — the session/lobby was created.
- `player.joined` — a player joined.
- `player.ready` — Ready was accepted by the server.
- `session.started` — both players became Ready and the session transitioned to active.
- `player.disconnected` / `player.reconnected`.
- `player.turn_passed`.
- `session.ended` — final authoritative session state.

The `/session-closed` endpoint captures the separate matchmaking service callback that is sent when session cleanup concludes.

Both endpoints verify `X-Hub-Signature-256` using the same HMAC secret as the game server. Captures are kept in memory for the dashboard and appended to `captured.ndjson` for local inspection. The capture file and `.env` are ignored by Git.

## Dashboard/API

- `GET /health` — catcher health and HMAC configuration state.
- `GET /api/events` — all captured events. Optional `sessionId`, `eventType`, and `after` query parameters.
- `GET /api/summary` — per-session event counts and invalid-signature count.
- `DELETE /api/events` — clear the current capture.

## TTL matrix test

The reusable test is `ttl-matrix-test.js` (`npm run test:ttl`). It creates five independent session instances and verifies their state before expiry:

1. Empty session — no players.
2. One connected player — not Ready.
3. Two connected players — 0/2 Ready.
4. Two connected players — 1/2 Ready.
5. Two connected players — 2/2 Ready, active, no moves.

For a quick TTL test, temporarily set the game server's `SESSION_MAX_LIFETIME_MS` to the same value as `TEST_TTL_MS` in `WebhookCatcher/.env` (currently 25 seconds), restart the game server, and run:

```text
npm run test:ttl
```

The test requires every session to disappear after TTL, every session to emit exactly one `session.created`, one `session.ended`, and one `session.closed`, all signatures to verify, and only the 2/2 Ready session to emit exactly one `session.started`. It also asserts that the pre-release `game.started` name is no longer emitted.

After testing, restore the game server TTL to its normal production value. The verified production value is currently 3,600,000 ms (1 hour).

## Latest verified results

- Five concurrent TTL-state sessions: PASS.
- Every TTL session removed after expiry: PASS.
- Correct webhook count per session state: PASS.
- Exactly one `session.started` for the 2/2 Ready transition: PASS.
- `session.ended` and `session.closed` for every expired session: PASS.
- HMAC signature verification across both outbound channels: PASS (0 invalid signatures).
- Normal Bot-vs-Bot game at the restored 1-hour TTL: PASS; `session.created` → `session.started` → normal win → `session.ended` → `session.closed` all captured.
