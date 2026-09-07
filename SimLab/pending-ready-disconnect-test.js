const assert = require('assert');
const { io } = require('socket.io-client');

const SIMLAB_URL = (process.env.SIMLAB_URL || 'https://app2.solarcal.xyz').replace(/\/$/, '');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${SIMLAB_URL}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });
}

async function connectAndJoin(serverUrl, sessionId, playerId, playerName) {
  const socket = io(serverUrl, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: false,
  });
  if (!socket.connected) await once(socket, 'connect');
  const ack = await new Promise((resolve) => {
    socket.emit('join', { sessionId, playerId, playerName }, resolve);
  });
  assert.equal(ack?.success, true, `join failed: ${JSON.stringify(ack)}`);
  return socket;
}

(async () => {
  const config = await api('/api/config');
  const created = await api('/api/sessions', { method: 'POST', body: { turnDurationSec: 30 } });
  const sessionId = created.sessionId;
  const playerA = `pending-a-${Date.now()}`;
  const playerB = `pending-b-${Date.now()}`;
  let a;
  let b;

  try {
    a = await connectAndJoin(config.gameServerUrl, sessionId, playerA, 'Pending A');
    b = await connectAndJoin(config.gameServerUrl, sessionId, playerB, 'Pending B');

    const readyA = once(a, 'ready-confirmed');
    a.emit('player-ready', { sessionId, playerId: playerA });
    await readyA;

    a.disconnect();
    await wait(300);

    let sessions = await api('/api/sessions');
    let state = sessions.find((session) => session.sessionId === sessionId);
    assert(state, 'session disappeared');
    const stateA = state.players.find((player) => player.playerId === playerA);
    assert.equal(state.status, 'pending');
    assert.equal(stateA.connected, false, 'disconnected Ready player still marked connected');
    assert.equal(stateA.ready, false, 'disconnected Ready player retained stale Ready vote');

    let gameFoundB = 0;
    b.on('game-found', () => { gameFoundB += 1; });
    const readyB = once(b, 'ready-confirmed');
    b.emit('player-ready', { sessionId, playerId: playerB });
    await readyB;
    await wait(300);

    sessions = await api('/api/sessions');
    state = sessions.find((session) => session.sessionId === sessionId);
    const stateB = state.players.find((player) => player.playerId === playerB);
    assert.equal(state.status, 'pending', 'game started with disconnected opponent');
    assert.equal(stateB.ready, true, 'connected player Ready was not retained');
    assert.equal(gameFoundB, 0, 'game-found emitted while opponent was disconnected');

    console.log('PENDING_READY_DISCONNECT=PASS');
  } finally {
    a?.disconnect();
    b?.disconnect();
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST' });
    } catch {}
  }
})().catch((error) => {
  console.error('PENDING_READY_DISCONNECT=FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
