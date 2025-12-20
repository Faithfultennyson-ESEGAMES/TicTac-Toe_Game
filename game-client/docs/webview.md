# WebView and iframe Integration (postMessage)

This client can be embedded in a parent application (WebView or iframe) and will send events to the parent using the postMessage API. The client exposes a global helper in `js/main.js`:

- `window.broadcastEvent(type, payload)`

When called, it posts `{ type, payload }` to `window.parent` (or to `window` if not embedded).

## Parent-side listener example

```javascript
window.addEventListener('message', (event) => {
  // Recommended: validate the sender
  // if (event.origin !== 'http://your-game-client-domain.com') {
  //   return;
  // }

  const { type, payload } = event.data || {};

  switch (type) {
    case 'INVALID_SESSION':
      console.log('Game session is invalid:', payload);
      // payload: { sessionId: string | null, reason: string }
      break;

    case 'CONNECTION_FAILED':
      console.log('Failed to connect to the game server:', payload);
      // payload: { reason: string, source: 'init' | 'rejoin' }
      break;
  }
});
```

## Dispatched events

### INVALID_SESSION

- Triggered when a player attempts to join or rejoin a session that is invalid, has ended, or cannot be found.
- Payload: `{ sessionId: string | null, reason: string }`

Common reasons:
- `invalid_link` (missing joinUrl/playerId/playerName)
- `join_error` (server rejected join)
- `session_ended`
- `missing_session` (no stored session for rejoin)
- `session_unavailable` (rejoin fetch failed or session ended)

### CONNECTION_FAILED

- Triggered when the client fails to establish or re-establish a WebSocket connection (initial connect, rejoin, or reconnect failure).
- Payload: `{ reason: string, source: 'init' | 'rejoin' }`

Common reasons:
- `Unknown error` (initial connect failed without specific message)
- `Connection timeout`
- `reconnect_failed`
- Other socket error messages passed through as `reason`

## Notes

- Messages are posted with `targetOrigin = '*'`. For production apps, check `event.origin` before handling.
- If the game is not embedded, messages are posted to the same window.
