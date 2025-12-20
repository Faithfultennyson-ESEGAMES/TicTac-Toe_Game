### Game Client Summary (`summary_client.md`)

#### 1. How the client is organized and loaded

*   **Main File:** `index.html` is the single entry point for the application.
*   **Stylesheets:** The client loads three CSS files from the `css/` directory:
    *   `styles.css`: Main styling.
    *   `mobile.css`: Responsive styles for mobile devices.
    *   `animations.css`: Keyframe animations for UI effects.
*   **JavaScript Loading:**
    1.  **Main Logic:** The application's entry point is `js/main.js`, loaded as a `type="module"`.
    2.  **Dependencies:** Socket.IO is loaded from a CDN at runtime (via an inline script in `index.html`), then the ES module code starts.
*   **Code Organization (ES6 Modules):**
    *   `js/main.js`: Initializes the entire application after the DOM is loaded. It creates instances of the managers and the main game client. It also defines the global `broadcastEvent` function for parent communication.
    *   `js/gameClient.js`: The central orchestrator. It manages the game state, handles events from the UI and the socket, and directs the flow of the game.
    *   `js/socketManager.js`: Encapsulates all `socket.io` communication. It handles connecting, sending messages, and receiving events from the server.
    *   `js/uiManager.js`: Manages all DOM manipulation. It updates the board, player info, timers, and shows/hides overlays and modals. It does not contain any game logic itself.
    *   `js/audioManager.js`: Handles playing sound effects for game events.
    *   `js/urlParser.js`: A utility to parse query parameters from the URL, accepting both `camelCase`  keys.

#### 2. How to Play a Game

To play a game, you need to construct a URL with the following query parameters ( `camelCase`):

*   `joinUrl`: The join URL that includes the session path (e.g., `http://host/session/<id>` or `ws://host/session/<id>`). The client extracts the `sessionId` from this URL.
*   `playerId`: Your unique player ID.
*   `playerName`: Your display name.

**Example URL:**

```
http://<your-client-url>/index.html?joinurl=http://<your-server-url>/session/some-session-id&playerId=player1&playerName=PlayerOne
```

When you open this URL, the client will automatically attempt to connect to the server and join the specified game session.


#### 3. UI screens/components and their flow

The UI is a single page with different states managed by showing/hiding elements.

*   **Components:**
    *   `#game-container`: The main wrapper for the game interface.
    *   `#player-info`: Header displaying names for Player X and Player O.
    *   `#turn-indicator`: Shows whose turn it is and a countdown timer.
    *   `#game-board`: The 3x3 grid of clickable buttons.
    *   `#overlay`: A full-screen overlay with a spinner and text, used for loading states (`Connecting...`, `Waiting for match...`, etc.).
    *   `#result-modal`: A dialog that can be used for end-of-game messaging (not shown in the current flow).
    *   **Player names:** Color-coded by symbol and capped at 12 characters (long names are truncated with `..`).
*   **UI Flow:**
    1.  **Initial Load:** The page loads, and the `#overlay` is immediately shown with a "Connecting..." message.
    2.  **Joining:** Once connected, the overlay text changes to "Joining Game Session...".
    3.  **Game Start:** When the server emits `game-found`, the overlay is hidden, and the main game board and player info are displayed.
    4.  **Gameplay:** The UI updates in real-time to reflect the board state, current turn, and timer.
    5.  **Game End:** When the server emits `game-ended`, the client waits ~3 seconds and then shows a top banner overlay (no dimming) while the board remains visible.

#### 4. WebSocket connection lifecycle

*   **Connection:** `socketManager.js` initiates the connection to the server URL provided in the `joinUrl` query parameter.
*   **Disconnect Handling:** The client has built-in logic to automatically attempt reconnection. If it reconnects and a session was in progress, it will attempt to rejoin. If the connection ultimately fails, a `CONNECTION_FAILED` message is sent to the parent window (see Section 9).
*   **Messages Sent (by Client):**
    *   `join`: On initial connection, to join a game session.
    *   `make-move`: When the player places a symbol.
    *   `relocate-move`: When a player moves an existing symbol.
*   **Messages Received (from Server):**
    *   `join-error`: If the client fails to join the session. This triggers an `INVALID_SESSION` message to the parent window (see Section 9).
    *   `game-found`: Triggers the start of the game UI.
    *   `turn-started`: Updates the turn indicator and timer.
    *   `move-applied`: Updates the board with the new move.
    *   `move-error`: If a move is rejected by the server.
    *   `game-ended`: Shows the end screen.
    *   `player-disconnected`: Shows a notification that the opponent has disconnected.
    *   `player-reconnected`: Shows a notification that the opponent has reconnected.

#### 5. How turns/moves are sent to the server

1.  `uiManager.js` attaches an event listener to the `#game-board` wrapper.
2.  When a click event occurs on a `.board-cell`, it invokes a callback in `gameClient.js`.
3.  This callback checks if it is the local player's turn.
4.  If it is, `gameClient.js` calls `socketManager.emit()` with either `make-move` or `relocate-move`, sending a payload with `sessionId`, `playerId`, and move details.

#### 6. How state/score/turn updates are displayed

*   **State:** The `gameClient.js` instance holds the canonical client-side state.
*   **Turn Updates:** On a `turn-started` event, `gameClient.js` updates its internal state and calls the `uiManager` to update the DOM, showing whose turn it is and starting the countdown timer.
*   **Board Updates:** On a `move-applied` event, `gameClient.js` calls `uiManager.setBoardState()` to place the 'X' or 'O' symbol on the correct cell.

#### 7. What happens on game end

*   The `gameClient.js` listens for the `game-ended` event from the server.
*   It stops timers, clears the session, and waits ~3 seconds before showing a small banner at the top (the board stays visible).
*   The final move is expected to be rendered by the preceding `move-applied` event.

#### 8. Bugs, inconsistencies, or risky assumptions

1.  **CDN Dependency:** Socket.IO is loaded from a CDN at runtime; connectivity issues or blocked CDNs will prevent the client from connecting.

#### 9. WebView & iframe Integration (`postMessage` API)

The game client is designed to be embedded into a parent application (e.g., a React or mobile app) using a `WebView` or an `iframe`. To facilitate communication from the game back to the parent, the client dispatches events using the `window.parent.postMessage()` API.

A global function `broadcastEvent(type, payload)` is available in `js/main.js` to standardize this communication.

**Listening for Events in the Parent App:**

A developer embedding the game can listen for these messages on the `window` object.

```javascript
// Example: How a parent application can listen for game events
window.addEventListener('message', (event) => {
  // Recommended: Check the event origin for security
  // if (event.origin !== 'http://your-game-client-domain.com') {
  //   return;
  // }

  const { type, payload } = event.data;

  switch (type) {
    case 'INVALID_SESSION':
      console.log('Game session is invalid:', payload);
      // Example: Close the WebView or show an error to the user
      // payload: { sessionId: string | null, reason: string }
      break;

    case 'CONNECTION_FAILED':
      console.log('Failed to connect to the game server:', payload);
      // Example: Display a native error message
      // payload: { reason: string, source: 'init' | 'rejoin' }
      break;
  }
});
```

**Dispatched Events:**

*   **`INVALID_SESSION`**:
    *   **Trigger**: Fired when a player attempts to join or rejoin a session that is invalid, has ended, or does not exist.
    *   **Payload**: ` { sessionId: string | null, reason: string } `
*   **`CONNECTION_FAILED`**:
    *   **Trigger**: Fired when the client fails to establish or re-establish a WebSocket connection (initial connect, rejoin, or reconnect failure).
    *   **Payload**: ` { reason: string, source: 'init' | 'rejoin' } `

#### 10. Local docs & test pages

*   `docs/webview.md`: Detailed postMessage integration guide for parent apps.
