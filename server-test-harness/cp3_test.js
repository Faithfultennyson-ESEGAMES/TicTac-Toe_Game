// cp3_test.js
const { io } = require("socket.io-client");

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.log("Usage: node cp3_test.js <session_id>");
  process.exit(1);
}

// change port if needed
const URL = "http://localhost:5500";

function makeClient(label, playerId, playerName) {
  const socket = io(URL, { transports: ["websocket"] });

  socket.on("connect", () => {
    console.log(`[${label}] connected:`, socket.id);
    socket.emit("join", { session_id: SESSION_ID, playerId, playerName });
  });

  socket.on("join-error", (e) => console.log(`[${label}] join-error:`, e));
  socket.on("game-found", (d) => console.log(`[${label}] game-found:`, d));
  socket.on("turn-started", (d) => console.log(`[${label}] turn-started:`, d));
  socket.on("move-applied", (d) => console.log(`[${label}] move-applied:`, d));
  socket.on("game-ended", (d) => console.log(`[${label}] game-ended:`, d));
  socket.on("player-disconnected", (d) =>
    console.log(`[${label}] player-disconnected:`, d)
  );
  socket.on("player-reconnected", (d) =>
    console.log(`[${label}] player-reconnected:`, d)
  );
  socket.on("move-error", (d) => console.log(`[${label}] move-error:`, d));
  socket.on("error", (d) => console.log(`[${label}] error:`, d));

  socket.on("disconnect", () => console.log(`[${label}] disconnected`));

  return socket;
}

const p1 = makeClient("p1", "p1", "Alice");

setTimeout(() => {
  const p2 = makeClient("p2", "p2", "Bob");

  // Helper to send a move
  const move = (sock, label, pos, delay) =>
    setTimeout(() => {
      console.log(`[${label}] make-move ->`, pos);
      sock.emit("make-move", {
        session_id: SESSION_ID,
        playerId: label,
        position: pos,
      });
    }, delay);

  // ---- Scripted test flow ----
  // Wait a bit for game-found/turn-started to arrive
  // 1) Valid opening move by p1 (pos 0)
  move(p1, "p1", 0, 1500);

  // 2) INVALID move by p1 again (out of turn) -> should trigger move-error
  move(p1, "p1", 1, 2000);

  // 3) Valid move by p2 (pos 4)
  move(p2, "p2", 4, 2600);

  // 4) Let p1 timeout once (DON'T move). We wait longer than turn duration.
  // If TURN_DURATION_SEC=15 from /start, wait ~17s.
  setTimeout(() => {
    console.log("[test] waiting for p1 timeout/pass...");
  }, 3200);

  // 5) After timeout should be p2's turn. p2 plays pos 8
  move(p2, "p2", 8, 20000);

  // 6) Disconnect p2 during p1 turn, then reconnect
  setTimeout(() => {
    console.log("[test] disconnecting p2...");
    p2.disconnect();
  }, 23000);

  setTimeout(() => {
    console.log("[test] reconnecting p2...");
    makeClient("p2-re", "p2", "Bob");
  }, 25000);

  // 7) Finish a win for p1: positions 0,1,2 line
  // p1 should now be able to play
  move(p1, "p1", 1, 27000);
  move(p2, "p2", 3, 29000); // p2 random
  move(p1, "p1", 2, 31000); // p1 wins here

}, 1000);
