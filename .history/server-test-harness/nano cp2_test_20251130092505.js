const { io } = require("socket.io-client");

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.log("Usage: node cp2_test.js <session_id>");
  process.exit(1);
}

// Use your game-server port here:
const URL = "http://localhost:30000";

function joinPlayer(playerId, playerName) {
  const socket = io(URL, { transports: ["websocket"] });

  socket.on("connect", () => {
    console.log(playerId, "connected:", socket.id);
    socket.emit("join", {
      session_id: SESSION_ID,
      playerId,
      playerName,
    });
  });

  socket.on("join-error", (e) => {
    console.log(playerId, "join-error:", e);
  });

  socket.on("game-found", (data) => {
    console.log(playerId, "game-found:", data);
  });

  socket.on("disconnect", () => {
    console.log(playerId, "disconnected");
  });

  return socket;
}

// Player 1 joins immediately
const p1 = joinPlayer("p1", "Alice");

// Player 2 joins after 1s
setTimeout(() => {
  const p2 = joinPlayer("p2", "Bob");

  // Simulate reconnect for p1
  setTimeout(() => {
    console.log("Simulating reconnect for p1...");
    p1.disconnect();
    setTimeout(() => joinPlayer("p1", "Alice"), 1000);
  }, 2000);

}, 1000);
