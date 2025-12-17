import GameClient from "./gameClient.js";

/**
 * Sends a message to the parent window, if one exists.
 * This is used for communicating with a parent application when the game is embedded in a WebView or iframe.
 * @param {string} type - The event type.
 * @param {object} payload - The data to send.
 */
function broadcastEvent(type, payload) {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type, payload }, '*');
    console.log(`BROADCAST: ${type}`, payload);
  }
}

// Make it globally accessible for other modules.
window.broadcastEvent = broadcastEvent;


// A short delay helps prevent race conditions during initial load.
window.addEventListener('load', () => {
  setTimeout(() => {
    const client = new GameClient();
    client.init();
  }, 100); // 100ms delay
});
