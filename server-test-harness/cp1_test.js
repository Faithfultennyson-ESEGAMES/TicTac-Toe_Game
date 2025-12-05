const { io } = require("socket.io-client");

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.log("Usage: node cp1_test.js <session_id>");
  process.exit(1);
}

// Use your game-server port here:
const URL = "http://localhost:5500";

function joinPlayer(playerId, playerName) {
  const socket = io(URL, { transports: ["websocket"] });

  socket.on("connect", () => {
    console.log(`[${playerId}] Connected: ${socket.id}`);
    socket.emit("join", {
      session_id: SESSION_ID,
      playerId,
      playerName,
    });
  });

  socket.on("join-error", (e) => {
    console.log(`[${playerId}] join-error:`, e);
  });

  socket.on("game-found", (data) => {
    console.log(`[${playerId}] game-found:`, data);
  });

  socket.on("game-state", (data) => {
    console.log(`[${playerId}] game-state:`, data);
  });

  socket.on("game-start", (data) => {
    console.log(`[${playerId}] game-start:`, data);
  });

  socket.on("turn-update", (data) => {
    console.log(`[${playerId}] turn-update:`, data);
  });

  socket.on("move-result", (data) => {
    console.log(`[${playerId}] move-result:`, data);
  });

  socket.on("error", (error) => {
    console.log(`[${playerId}] error:`, error);
  });

  socket.on("disconnect", () => {
    console.log(`[${playerId}] disconnected`);
  });

  return socket;
}

// Player 1 joins
console.log("=== Single Player Test ===");
console.log("Player 1 joining...");
const p1 = joinPlayer("p1", "Alice");

// After 30 seconds, make a move
setTimeout(() => {
  console.log("\n=== 30 seconds elapsed - Attempting to make a move ===");
  p1.emit("make-move", {
    session_id: SESSION_ID,
    playerId: "p1",
    row: 0,
    col: 0,
  });
}, 30000);

// Keep running indefinitely to see server responses
// Press Ctrl+C to exit
console.log("\n(Press Ctrl+C to exit. Waiting for server responses...)\n");
