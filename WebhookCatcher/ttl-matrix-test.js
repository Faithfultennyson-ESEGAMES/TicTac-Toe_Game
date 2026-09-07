const path = require('path');
const { io } = require('socket.io-client');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const GAME_SERVER_URL = (process.env.GAME_SERVER_URL || 'https://app1.solarcal.xyz').replace(/\/$/, '');
const CATCHER_URL = (process.env.CATCHER_URL || 'https://app2.solarcal.xyz').replace(/\/$/, '');
const GAME_SERVER_TOKEN = process.env.GAME_SERVER_TOKEN || '';
const TEST_TTL_MS = Number.parseInt(process.env.TEST_TTL_MS, 10) || 25000;
const openSockets = new Set();

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }

async function request(base, route, { method = 'GET', body, auth = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && GAME_SERVER_TOKEN) headers.Authorization = `Bearer ${GAME_SERVER_TOKEN}`;
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`${method} ${route} failed: ${data?.error || data?.message || response.status}`);
  return data;
}

async function startSession(label) {
  const session = await request(GAME_SERVER_URL, '/start', {
    method: 'POST',
    auth: true,
    body: { turnDurationSec: 60 },
  });
  return { label, ...session, sockets: [], players: [] };
}

function waitFor(socket, event, timeoutMs = 5000, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function joinPlayer(test, suffix) {
  const player = {
    playerId: `ttl-${test.label}-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    playerName: `${test.label}-${suffix}`,
  };
  const socket = io(GAME_SERVER_URL, {
    transports: ['websocket', 'polling'],
    reconnection: false,
    timeout: 5000,
  });
  openSockets.add(socket);
  socket.on('disconnect', () => openSockets.delete(socket));
  await waitFor(socket, 'connect', 7000);
  const ack = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Join ack timeout for ${player.playerName}`)), 5000);
    socket.emit('join', { sessionId: test.sessionId, ...player }, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
  assert(ack?.success, `Join failed for ${player.playerName}: ${ack?.message || 'unknown'}`);
  test.sockets.push(socket);
  test.players.push(player);
  return { socket, player };
}

async function ready(test, index) {
  const socket = test.sockets[index];
  const player = test.players[index];
  const confirmed = waitFor(socket, 'ready-confirmed', 5000, (payload) => payload?.playerId === player.playerId);
  socket.emit('player-ready', { sessionId: test.sessionId, playerId: player.playerId });
  await confirmed;
}

async function getActiveSessions() {
  return request(GAME_SERVER_URL, '/admin/sessions/active', { auth: true });
}

function byId(sessions, id) { return sessions.find((session) => session.sessionId === id); }

async function main() {
  assert(GAME_SERVER_TOKEN, 'GAME_SERVER_TOKEN is missing in WebhookCatcher/.env');
  const catcherHealth = await request(CATCHER_URL, '/health');
  assert(catcherHealth.ok, 'Webhook catcher is not healthy');
  assert(catcherHealth.hmacConfigured, 'Webhook catcher HMAC verification is not configured');
  await request(CATCHER_URL, '/api/events', { method: 'DELETE' });

  console.log(`TTL matrix target: ${GAME_SERVER_URL}`);
  console.log(`Catcher: ${CATCHER_URL}`);
  console.log(`Expected test TTL: ~${TEST_TTL_MS}ms`);

  const tests = {
    empty: await startSession('empty'),
    one: await startSession('one-connected'),
    two0: await startSession('two-zero-ready'),
    two1: await startSession('two-one-ready'),
    two2: await startSession('two-both-ready'),
  };

  await joinPlayer(tests.one, 'A');
  await joinPlayer(tests.two0, 'A');
  await joinPlayer(tests.two0, 'B');
  await joinPlayer(tests.two1, 'A');
  await joinPlayer(tests.two1, 'B');
  await ready(tests.two1, 0);
  await joinPlayer(tests.two2, 'A');
  await joinPlayer(tests.two2, 'B');
  await ready(tests.two2, 0);
  await ready(tests.two2, 1);

  const activeBefore = await getActiveSessions();
  const expected = [tests.empty, tests.one, tests.two0, tests.two1, tests.two2];
  for (const test of expected) assert(byId(activeBefore, test.sessionId), `${test.label} missing before TTL expiry`);

  assert(byId(activeBefore, tests.empty.sessionId).players.length === 0, 'empty session did not stay empty');
  assert(byId(activeBefore, tests.one.sessionId).players.length === 1, 'one-connected session player count mismatch');
  assert(byId(activeBefore, tests.two0.sessionId).status === 'pending', 'two-zero-ready should be pending');
  assert(byId(activeBefore, tests.two0.sessionId).players.filter((p) => p.ready).length === 0, 'two-zero-ready readiness mismatch');
  assert(byId(activeBefore, tests.two1.sessionId).status === 'pending', 'two-one-ready should be pending');
  assert(byId(activeBefore, tests.two1.sessionId).players.filter((p) => p.ready).length === 1, 'two-one-ready readiness mismatch');
  assert(byId(activeBefore, tests.two2.sessionId).status === 'active', 'two-both-ready should be active');
  assert(byId(activeBefore, tests.two2.sessionId).players.filter((p) => p.ready).length === 2, 'two-both-ready readiness mismatch');
  console.log('PASS: all five concurrent sessions reached their intended pre-TTL states');

  await sleep(TEST_TTL_MS + 5000);

  const activeAfter = await getActiveSessions();
  for (const test of expected) {
    assert(!byId(activeAfter, test.sessionId), `${test.label} still exists after TTL`);
  }
  console.log('PASS: all five sessions were removed after TTL');

  // Give fire-and-forget webhook delivery a little time to settle.
  await sleep(1500);
  const allEvents = await request(CATCHER_URL, '/api/events');

  const expectations = new Map([
    [tests.empty.sessionId, { joined: 0, ready: 0, sessionStarted: 0 }],
    [tests.one.sessionId, { joined: 1, ready: 0, sessionStarted: 0 }],
    [tests.two0.sessionId, { joined: 2, ready: 0, sessionStarted: 0 }],
    [tests.two1.sessionId, { joined: 2, ready: 1, sessionStarted: 0 }],
    [tests.two2.sessionId, { joined: 2, ready: 2, sessionStarted: 1 }],
  ]);

  for (const [sessionId, exp] of expectations) {
    const events = allEvents.filter((event) => event.sessionId === sessionId);
    const count = (type) => events.filter((event) => event.eventType === type).length;
    assert(count('session.created') === 1, `${sessionId}: expected one session.created, got ${count('session.created')}`);
    assert(count('player.joined') === exp.joined, `${sessionId}: expected ${exp.joined} player.joined, got ${count('player.joined')}`);
    assert(count('player.ready') === exp.ready, `${sessionId}: expected ${exp.ready} player.ready, got ${count('player.ready')}`);
    assert(count('session.started') === exp.sessionStarted, `${sessionId}: expected ${exp.sessionStarted} session.started, got ${count('session.started')}`);
    assert(count('game.started') === 0, `${sessionId}: legacy game.started must not be emitted`);
    assert(count('session.ended') === 1, `${sessionId}: expected one session.ended, got ${count('session.ended')}`);
    assert(count('session.closed') === 1, `${sessionId}: expected one session.closed, got ${count('session.closed')}`);
    assert(events.every((event) => event.signatureValid === true), `${sessionId}: one or more HMAC signatures were invalid`);
    const ended = events.find((event) => event.eventType === 'session.ended');
    const closed = events.find((event) => event.eventType === 'session.closed');
    assert(ended?.body?.endReason === 'expired', `${sessionId}: session.ended reason was not expired`);
    assert(closed?.body?.endReason === 'expired', `${sessionId}: session.closed reason was not expired`);
  }

  console.log('PASS: webhook counts match each session state, including exactly one session.started for 2/2 Ready and no legacy game.started events');
  console.log('PASS: every captured dispatcher/session-closed HMAC signature is valid');
  console.log('PASS: every TTL termination reported endReason=expired on both outbound channels');
  console.log('TTL_MATRIX=PASS');

  for (const test of expected) {
    for (const socket of test.sockets) socket.disconnect();
  }
}

main()
  .catch((error) => {
    console.error('TTL_MATRIX=FAIL');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const socket of openSockets) socket.disconnect();
    openSockets.clear();
  });
