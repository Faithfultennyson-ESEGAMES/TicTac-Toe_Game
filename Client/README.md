# Legacy Client Copy

`Server/public/` is the canonical Tic-Tac-Toe production client and the only client served by the game server.

Do not deploy or make production fixes in this `Client/` directory. It is retained only as a historical/legacy copy.

The production browser entry point is `Server/public/js/main.js`. `npm run build:client` bundles and transpiles it to `Server/public/js/app.bundle.js` for WebView compatibility, and `npm start` runs that build automatically before starting the server.
