### Game Client Summary (`summary_client.md`)

#### 1. How the client is organized and loaded

*   **Main File:** `index.html` is the single entry point for the application.
*   **Stylesheets:** The client loads three CSS files from the `css/` directory:
    *   `styles.css`: Main styling.
    *   `mobile.css`: Responsive styles for mobile devices.
    *   `animations.css`: Keyframe animations for UI effects.
*   **JavaScript Loading:**
    1.  **Socket.IO:** The Socket.IO client library is loaded dynamically from a CDN directly within `index.html`. This is done to avoid cross-origin issues and ensures the library is available globally as `window.io`.
    2.  **Main Logic:** The application's entry point is `js/main.js`, loaded as a `type="module"`.
*   **Code Organization (ES6 Modules):**
    *   `js/main.js`: Initializes the entire application after the DOM is loaded. It creates instances of the managers and the main game client.
    *   `js/gameClient.js`: The central orchestrator. It manages the game state, handles events from the UI and the socket, and directs the flow of the game.
    *   `js/socketManager.js`: Encapsulates all `socket.io` communication. It handles connecting, sending messages, and receiving events from the server.
    *   `js/uiManager.js`: Manages all DOM manipulation. It updates the board, player info, timers, and shows/hides overlays and modals. It does not contain any game logic itself.
    *   `js/audioManager.js`: Handles playing sound effects for game events.
    *   `js/connectionManager.js`: Manages the visual connection status indicator in the UI.
    *   `js/urlParser.js`: A simple utility to parse query parameters from the URL.

#### 2. How to Play a Game

To play a game, you need to construct a URL with the following query parameters:

*   `join_url`: The URL of the game server.
*   `session_id`: The ID of the game session.
*   `player_id`: Your unique player ID.
*   `player_name`: Your display name.

**Example URL:**

```
http://<your-client-url>/index.html?join_url=http://<your-server-url>&session_id=some-session-id&player_id=player1&player_name=PlayerOne
```

When you open this URL, the client will automatically connect to the server and join the specified game session.


#### 3. UI screens/components and their flow

The UI is a single page with different states managed by showing/hiding elements.

*   **Components:**
    *   `#game-container`: The main wrapper for the game interface.
    *   `#player-info`: Header displaying names for Player X and Player O.
    *   `#turn-indicator`: Shows whose turn it is and a countdown timer.
    *   `#game-board`: The 3x3 grid of clickable buttons.
    *   `#overlay`: A full-screen overlay with a spinner and text, used for loading states (`Connecting...`, `Waiting for match...`).
    *   `#result-modal`: A dialog that appears at the end of the game to show a neutral end screen.
*   **UI Flow:**
    1.  **Initial Load:** The page loads, and the `#overlay` is immediately shown with a "Connecting..." message.
    2.  **Queue:** Once connected to the server, the overlay text changes to "Waiting for match...".
    3.  **Game Start:** When the server emits `game-found`, the overlay is hidden, and the main game board and player info are displayed.
    4.  **Gameplay:** The UI updates in real-time to reflect the board state, current turn, and timer.
    5.  **Game End:** When the server emits `game-ended`, a neutral end screen is displayed.

#### 4. WebSocket connection lifecycle

*   **Connection:** `socketManager.js` initiates the connection to the server URL provided in the `join_url` query parameter.
*   **Disconnect Handling:** The `connectionManager.js` updates the UI to show a "Disconnected" status if the socket disconnects. The `socketManager` has built-in logic to automatically attempt reconnection. If it reconnects and a session was in progress, it will attempt to rejoin the session.
*   **Messages Sent (by Client):**
    *   `join`: On initial connection, to join a game session.
    *   `make-move`: When the player clicks a cell.
*   **Messages Received (from Server):**
    *   `join-error`: If the client fails to join the session.
    *   `game-found`: Triggers the start of the game UI.
    *   `turn-started`: Updates the turn indicator and timer.
    *   `move-applied`: Updates the board with the new move.
    *   `move-error`: If a move is rejected by the server.
    *   `game-ended`: Shows the end screen.
    *   `player-disconnected`: Shows a notification that the opponent has disconnected.
    *   `player-reconnected`: Shows a notification that the opponent has reconnected.

#### 5. How turns/moves are sent to the server

1.  `uiManager.js` attaches a single event listener to the `#game-board` wrapper.
2.  When a click event occurs on a `.board-cell` button, it invokes a callback passed to it by `gameClient.js`.
3.  This callback in `gameClient.js` checks if it is the player's turn.
4.  If it is, `gameClient.js` calls `socketManager.emit('make-move', { sessionId, playerId, position })`.
5.  The `position` is the integer value from the `data-index` attribute of the clicked cell button.

#### 6. How state/score/turn updates are displayed

*   **State:** The `gameClient.js` instance holds the canonical client-side state (`sessionId`, `playerSymbol`, `isMyTurn`, etc.).
*   **Turn Updates:** On a `turn-started` event, `gameClient.js` updates its internal state and calls `uiManager.updateTurn()`, which updates the DOM to show whose turn it is and starts the visual countdown timer.
*   **Board Updates:** On a `move-applied` event, `gameClient.js` calls `uiManager.setBoardState()`, which places an 'X' or 'O' symbol on the correct cell.
*   **Score:** The client does not display a numerical score.

#### 7. What happens on game end

*   The `gameClient.js` listens for the `game-ended` event.
*   `gameClient.js` then calls `uiManager.showEndScreen()` to display a neutral end screen.

#### 8. Bugs, inconsistencies, or risky assumptions

1.  **CDN Dependency:** The entire application's startup depends on the Socket.IO CDN being available. The `onerror` handler for the script tag only logs to the console, providing no feedback to the user if it fails to load.