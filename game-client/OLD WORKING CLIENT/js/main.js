import GameClient from "./gameClient.js";

// A short delay helps prevent race conditions during initial load.
window.addEventListener('load', () => {
  setTimeout(() => {
    const client = new GameClient();
    client.init();
  }, 100); // 100ms delay
});
