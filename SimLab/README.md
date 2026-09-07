# Tic Tac Toe SimLab

A local test harness for exercising the real Tic Tac Toe server/client lifecycle without the production matchmaking frontend.

## What it tests

- Bearer-authenticated `POST /start` session creation.
- Admin session listing and force-ending.
- Real Socket.IO player joins.
- Two-player Ready gating.
- Reliable bot Ready retries until server confirmation.
- Human vs Bot play through the real bundled game client in an iframe.
- Bot vs Bot automated play.
- Placement and relocation moves.
- Bot disconnect/reconnect behavior.
- Session/game end events and live logs.

## Setup

1. Configure and start `../Server` normally.
2. Edit `SimLab/.env`:
   - `GAME_SERVER_URL` is the game server base URL. The SimLab always opens the playable `joinUrl` returned by that server directly.
   - `GAME_SERVER_TOKEN` must match the game server Bearer token (`DLQ_PASSWORD`).
3. In `SimLab`, run `npm install` once, then `npm start`.
4. Open `http://localhost:4000` locally, or `https://app4.solarcal.xyz` through the configured Cloudflare tunnel.

Current tunnel mapping used for this project:
- Game server + bundled client: `https://app1.solarcal.xyz` -> `http://localhost:3000`
- SimLab: `https://app4.solarcal.xyz` -> `http://localhost:4000`

## Useful scenarios

### Human vs Bot

Creates a real server session, connects one automated bot, and loads the returned playable session URL into the Player WebView. Press **Ready** in the game client and play normally.

### Bot vs Bot

Creates a session and connects two bots. Both wait until the two-player lobby exists, then Ready using retry-until-confirmed behavior and play automatically.

### Network/reconnect checks

Use **Disconnect** and **Reconnect** on a bot card while watching Live Logs. The bot uses the same session/player identity when reconnecting, so the server's reconnect state can be observed directly.

### Session cleanup

Use **End Current Session** to exercise the authenticated admin end endpoint. The connected game client/bots should receive the server-side session end notification.
