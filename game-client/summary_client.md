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
    *   `js/urlParser.js`: A simple utility to parse the `playerId` from the URL query string (`?id=...`).

#### 2. UI screens/components and their flow

The UI is a single page with different states managed by showing/hiding elements.

*   **Components:**
    *   `#game-container`: The main wrapper for the game interface.
    *   `#player-info`: Header displaying names for Player X and Player O.
    *   `#turn-indicator`: Shows whose turn it is and a countdown timer.
    *   `#game-board`: The 3x3 grid of clickable buttons.
    *   `#overlay`: A full-screen overlay with a spinner and text, used for loading states (`Connecting...`, `Waiting for match...`).
    *   `#result-modal`: A dialog that appears at the end of the game to show the final outcome.
*   **UI Flow:**
    1.  **Initial Load:** The page loads, and the `#overlay` is immediately shown with a "Connecting..." message.
    2.  **Queue:** Once connected to the server, the overlay text changes to "Waiting for match...".
    3.  **Game Start:** When the server emits `game-found`, the overlay is hidden, and the main game board and player info are displayed.
    4.  **Gameplay:** The UI updates in real-time to reflect the board state, current turn, and timer.
    5.  **Game End:** When the server emits `game-ended`, the `#result-modal` is displayed, showing the outcome (Win, Lose, Draw). The user has options to "Find New Game" or "Close".

#### 3. How a player joins a session

1.  The client expects the player's ID to be provided in the URL, e.g., `.../index.html?id=player123`.
2.  `urlParser.js` reads this `id` from the query string.
3.  `socketManager.js` first sends a `register-player` event with the `{ id }`.
4.  Immediately after, it sends a `join-queue` event.
5.  **Payload:** The payload sent for `join-queue` is an object that contains **only the `id` field**: `{ id: 'player123' }`. This correctly adheres to the product requirement that staking/payment parameters must be removed.

#### 4. WebSocket connection lifecycle

*   **Connection:** `socketManager.js` initiates the connection to the hardcoded server URL.
*   **Disconnect Handling:** The `connectionManager.js` updates the UI to show a "Disconnected" status if the socket disconnects. The `socketManager` has built-in logic to automatically attempt reconnection. If it reconnects and a session was in progress, it will attempt to send a `rejoin-session` event.
*   **Messages Sent (by Client):**
    *   `register-player`: On initial connection.
    *   `join-queue`: To enter matchmaking.
    *   `make-move`: When the player clicks a cell.
    *   `forfeit`: When the player clicks the "Forfeit" button.
    *   `rejoin-session`: If the client reconnects mid-game.
*   **Messages Received (from Server):**
    *   `game-found`: Triggers the start of the game UI.
    *   `turn-started`: Updates the turn indicator and timer.
    *   `move-applied`: Updates the board with the new move.
    *   `game-ended`: Shows the result modal.
    *   `player-disconnected`: Shows a notification that the opponent has disconnected.
    *   `player-rejoined`: Shows a notification that the opponent has reconnected.

#### 5. How turns/moves are sent to the server

1.  `uiManager.js` attaches a single event listener to the `#game-board` wrapper.
2.  When a click event occurs on a `.board-cell` button, it invokes a callback passed to it by `gameClient.js`.
3.  This callback in `gameClient.js` checks if it is the player's turn.
4.  If it is, `gameClient.js` calls `socketManager.emit('make-move', { sessionId, position })`.
5.  The `position` is the integer value from the `data-index` attribute of the clicked cell button.

#### 6. How state/score/turn updates are displayed

*   **State:** The `gameClient.js` instance holds the canonical client-side state (`sessionId`, `mySymbol`, `isMyTurn`, etc.).
*   **Turn Updates:** On a `turn-started` event, `gameClient.js` updates its internal state and calls `uiManager.updateTurn()`, which updates the DOM to show whose turn it is and starts the visual countdown timer.
*   **Board Updates:** On a `move-applied` event, `gameClient.js` calls `uiManager.updateBoard()`, which places an 'X' or 'O' symbol on the correct cell.
*   **Score:** The client does not display a numerical score. The UI has `#player-x-stake` and `#player-o-stake` elements, but they are never populated with data by the JavaScript, which aligns with the deprecation of staking features.

#### 7. What happens on game end

*   The `gameClient.js` listens for the `game-ended` event.
*   The event payload includes the `finalState`, which contains a `result` object (e.g., `{ outcome: 'win', winnerSymbol: 'X' }`).
*   `gameClient.js` determines if the local player won, lost, or drew based on their symbol and the `winnerSymbol` from the result.
*   It then calls `uiManager.showResultModal()` with the appropriate title and summary message.
*   **Contradiction with requirements:** The client UI **does show the winner**. It explicitly uses the `result` data from the server to tell the player if they won or lost. This is in direct conflict with the rule: "Final results are delivered via webhook only."

#### 8. Bugs, inconsistencies, or risky assumptions

1.  **Winner Displayed:** The most significant inconsistency is that the client **does** display the final game outcome to the user, which violates the product requirements.
2.  **Hardcoded Server URL:** The game server URL (`https://tiktactoegameserver-production.up.railway.app`) is hardcoded in a `<script>` tag in `index.html`. This is not a flexible or secure practice.
3.  **Dead UI Elements:** The HTML contains elements for displaying player stakes (`#player-x-stake`, `#player-o-stake`), but the JavaScript never populates them. These are unused legacy elements.
4.  **No Error Handling for Missing Player ID:** The `urlParser.js` does not handle the case where the `?id=` parameter is missing from the URL. This will cause the `join-queue` payload to be invalid, and the application will likely get stuck on the "Connecting..." screen without any user-facing error message.
5.  **CDN Dependency:** The entire application's startup depends on the Socket.IO CDN being available. The `onerror` handler for the script tag only logs to the console, providing no feedback to the user if it fails to load.
