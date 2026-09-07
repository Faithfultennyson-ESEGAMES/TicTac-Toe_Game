const { io } = require('socket.io-client');
const assert = require('assert');

const SIMLAB_URL = (process.env.SIMLAB_URL || 'http://127.0.0.1:4100').replace(/\/$/, '');

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  assert.equal(ack?.success, true, `join failed for ${playerName}: ${JSON.stringify(ack)}`);
  assert(ack?.reconnectToken, `join did not issue reconnect token for ${playerName}`);
  socket.__reconnectToken = ack.reconnectToken;
  return socket;
}

async function sessionState(sessionId) {
  const sessions = await api('/api/sessions');
  return sessions.find((session) => session.sessionId === sessionId) || null;
}

(async () => {
  const config = await api('/api/config');
  const created = await api('/api/sessions', { method: 'POST', body: { turnDurationSec: 30 } });
  const sessionId = created.sessionId;
  const playerA = `e2e-a-${Date.now()}`;
  const playerB = `e2e-b-${Date.now()}`;

  let a = null;
  let a2 = null;
  let attacker = null;
  let b = null;
  try {
    a = await connectAndJoin(config.gameServerUrl, sessionId, playerA, 'E2E A');
    b = await connectAndJoin(config.gameServerUrl, sessionId, playerB, 'E2E B');

    let gameFoundA = 0;
    let gameFoundB = 0;
    a.on('game-found', () => { gameFoundA += 1; });
    b.on('game-found', () => { gameFoundB += 1; });

    await wait(150);
    let state = await sessionState(sessionId);
    assert(state, 'session disappeared before Ready');
    assert.equal(state.status, 'pending', 'two connected players must not auto-start');
    assert.equal(state.players.length, 2, 'expected two connected players');
    assert.equal(state.players.filter((p) => p.ready).length, 0, 'no player should be Ready yet');
    console.log('PASS: two connected players remain pending with 0/2 Ready');

    const readyA = once(a, 'ready-confirmed');
    a.emit('player-ready', { sessionId, playerId: playerA });
    await readyA;
    await wait(100);
    state = await sessionState(sessionId);
    assert.equal(state.status, 'pending', 'one Ready must not start the game');
    assert.equal(state.players.filter((p) => p.ready).length, 1, 'expected exactly one Ready player');
    console.log('PASS: 1/2 Ready remains pending');

    const readyB = once(b, 'ready-confirmed');
    const foundA = once(a, 'game-found');
    const foundB = once(b, 'game-found');
    b.emit('player-ready', { sessionId, playerId: playerB });
    await Promise.all([readyB, foundA, foundB]);
    await wait(100);
    state = await sessionState(sessionId);
    assert.equal(state.status, 'active', '2/2 Ready must activate the game');
    assert.equal(state.players.filter((p) => p.ready).length, 2, 'expected two Ready players');
    assert.equal(gameFoundA, 1, 'player A should receive exactly one initial game-found');
    assert.equal(gameFoundB, 1, 'player B should receive exactly one initial game-found');
    console.log('PASS: 2/2 Ready activates exactly once');

    const duplicateConfirmed = once(a, 'ready-confirmed');
    a.emit('player-ready', { sessionId, playerId: playerA });
    await duplicateConfirmed;
    await wait(250);
    assert.equal(gameFoundA, 1, 'duplicate Ready must not emit another game-found to A');
    assert.equal(gameFoundB, 1, 'duplicate Ready must not emit another game-found to B');
    console.log('PASS: delayed duplicate Ready is idempotent after activation');

    const spoofError = once(a, 'move-error');
    a.emit('make-move', { sessionId, playerId: playerB, position: 0 });
    const spoofPayload = await spoofError;
    assert.match(spoofPayload?.message || '', /identity does not match/i, 'spoofed playerId should be rejected');
    console.log('PASS: move identity is bound to the authenticated socket');

    const reconnectTokenA = a.__reconnectToken;
    a.disconnect();
    await wait(150);

    attacker = io(config.gameServerUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: false,
    });
    await once(attacker, 'connect');
    const attackerAck = await new Promise((resolve) => {
      attacker.emit('join', { sessionId, playerId: playerA, playerName: 'E2E A' }, resolve);
    });
    assert.equal(attackerAck?.success, false, 'reconnect without token must be rejected');
    assert.match(attackerAck?.message || '', /authorization failed/i);
    attacker.disconnect();
    attacker = null;
    console.log('PASS: disconnected playerId cannot be hijacked without reconnect token');

    a2 = io(config.gameServerUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: false,
    });
    await once(a2, 'connect');
    const reFound = once(a2, 'game-found');
    const reconnectAck = await new Promise((resolve) => {
      a2.emit('join', {
        sessionId,
        playerId: playerA,
        playerName: 'E2E A',
        reconnectToken: reconnectTokenA,
      }, resolve);
    });
    assert.equal(reconnectAck?.success, true, 'reconnect join was not acknowledged');
    const rejoinState = await reFound;
    assert.equal(rejoinState.status, undefined);
    assert(rejoinState.expiresAt, 'reconnect game-found must include the active turn expiry');
    console.log('PASS: reconnect restores active game and current turn expiry');

    const endedA = once(a2, 'session-ended');
    const endedB = once(b, 'session-ended');
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST' });
    const [endPayloadA, endPayloadB] = await Promise.all([endedA, endedB]);
    assert.equal(endPayloadA.reason, 'admin_forced_end');
    assert.equal(endPayloadB.reason, 'admin_forced_end');
    await wait(100);
    assert.equal(await sessionState(sessionId), null, 'admin-ended session should be removed');
    console.log('PASS: admin end notifies connected clients and removes session');

    console.log('E2E_READY_FLOW=PASS');
  } finally {
    a?.disconnect();
    a2?.disconnect();
    attacker?.disconnect();
    b?.disconnect();
    try {
      if (await sessionState(sessionId)) {
        await api(`/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST' });
      }
    } catch {}
  }
})().catch((error) => {
  console.error('E2E_READY_FLOW=FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
