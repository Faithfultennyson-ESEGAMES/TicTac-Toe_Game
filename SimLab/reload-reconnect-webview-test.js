const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { io } = require('socket.io-client');

const SIMLAB_URL = (process.env.SIMLAB_URL || 'https://app2.solarcal.xyz').replace(/\/$/, '');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileDir = path.join(__dirname, `.chrome-reload-${process.pid}`);
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

function once(socket, event, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out waiting for ${event}`)); }, timeoutMs);
    const handler = (payload) => { clearTimeout(timer); resolve(payload); };
    socket.once(event, handler);
  });
}

async function startChrome() {
  fs.rmSync(profileDir, { recursive: true, force: true });
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=390,844', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devtoolsUrl = null;
  let stderr = '';
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) devtoolsUrl = match[1];
  });
  const deadline = Date.now() + 10000;
  while (!devtoolsUrl && Date.now() < deadline) { if (chrome.exitCode !== null) throw new Error('Chrome exited early'); await wait(50); }
  if (!devtoolsUrl) throw new Error('Timed out waiting for Chrome DevTools');

  const ws = new WebSocket(devtoolsUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let nextId = 1;
  const pending = new Map();
  const exceptions = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message)); else entry.resolve(msg.result || {});
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params?.exceptionDetails?.text || 'Runtime exception');
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    const message = { id, method, params }; if (sessionId) message.sessionId = sessionId; ws.send(JSON.stringify(message));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.sessionId;
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'Runtime evaluation failed');
    return out.result?.value;
  };
  return { chrome, ws, sessionId, send, evaluate, exceptions };
}

async function waitFor(evaluate, expression, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await wait(100); }
  throw new Error(`Timed out waiting for ${label}`);
}

(async () => {
  const config = await api('/api/config');
  const created = await api('/api/sessions', { method: 'POST', body: { turnDurationSec: 30 } });
  const sessionId = created.sessionId;
  const playerA = `reload-a-${Date.now()}`;
  const playerB = `reload-b-${Date.now()}`;
  const joinUrl = new URL(created.joinUrl);
  joinUrl.searchParams.set('playerId', playerA);
  joinUrl.searchParams.set('playerName', 'Reload Player');

  let browser; let b;
  try {
    browser = await startChrome();
    await browser.send('Page.navigate', { url: joinUrl.toString() }, browser.sessionId);
    await waitFor(browser.evaluate, `window.__tttBooted === true && document.getElementById('overlay-title')?.textContent === 'Waiting for Opponent'`, 'first player lobby');

    b = io(config.gameServerUrl, { path: '/socket.io', transports: ['websocket', 'polling'], reconnection: false });
    if (!b.connected) await once(b, 'connect');
    const joinAck = await new Promise((resolve) => b.emit('join', { sessionId, playerId: playerB, playerName: 'Opponent' }, resolve));
    assert.equal(joinAck?.success, true);

    await waitFor(browser.evaluate, `document.getElementById('overlay-title')?.textContent === 'Ready to Play?'`, 'ready prompt');
    await browser.evaluate(`document.getElementById('overlay-action').click()`);
    const readyB = once(b, 'ready-confirmed');
    b.emit('player-ready', { sessionId, playerId: playerB });
    await readyB;
    await waitFor(browser.evaluate, `!document.getElementById('board-wrapper').classList.contains('hidden') && document.getElementById('overlay').classList.contains('hidden')`, 'active board');

    const storedBefore = JSON.parse(await browser.evaluate(`sessionStorage.getItem('ttt.session')`));
    assert.equal(storedBefore.sessionId, sessionId);
    assert.equal(storedBefore.playerId, playerA);
    assert(storedBefore.reconnectToken && storedBefore.reconnectToken.length >= 32, 'reconnect token was not persisted');

    // Put a move on the board so reload must restore meaningful active state.
    const moveApplied = once(b, 'move-applied');
    await browser.evaluate(`document.querySelector('.board-cell[data-index="0"]').click()`);
    await moveApplied;

    for (let i = 1; i <= 2; i++) {
      await browser.send('Page.reload', { ignoreCache: true }, browser.sessionId);
      await waitFor(browser.evaluate,
        `window.__tttBooted === true && !document.getElementById('board-wrapper').classList.contains('hidden') && document.querySelector('.board-cell[data-index="0"]').textContent === 'X'`,
        `active board after reload ${i}`,
      );
      const state = JSON.parse(await browser.evaluate(`JSON.stringify({
        title: document.getElementById('overlay-title')?.textContent || '',
        boardHidden: document.getElementById('board-wrapper').classList.contains('hidden'),
        token: JSON.parse(sessionStorage.getItem('ttt.session') || '{}').reconnectToken || null
      })`));
      assert.equal(state.boardHidden, false);
      assert(state.token && state.token === storedBefore.reconnectToken, `reconnect token changed/lost on reload ${i}`);
      assert.notEqual(state.title, 'Connection Failed');
      assert.notEqual(state.title, 'Could Not Join');
    }

    const sessions = await api('/api/sessions');
    const live = sessions.find((s) => s.sessionId === sessionId);
    assert(live, 'session disappeared after reload');
    const reloadedPlayer = live.players.find((p) => p.playerId === playerA);
    assert(reloadedPlayer?.connected, 'reloaded player is not connected after reload');
    assert.equal(live.players.filter((p) => p.playerId === playerA).length, 1, 'reload duplicated the player');
    assert.equal(browser.exceptions.length, 0, `runtime exceptions: ${browser.exceptions.join('; ')}`);

    console.log('WEBVIEW_RELOAD_RECONNECT=PASS reloads=2 token=preserved player=single connected=YES board=restored');
  } finally {
    b?.disconnect();
    if (browser) { try { browser.ws.close(); } catch {} try { browser.chrome.kill(); } catch {} await wait(250); }
    fs.rmSync(profileDir, { recursive: true, force: true });
    try { await api(`/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST' }); } catch {}
  }
})().catch((error) => {
  console.error('WEBVIEW_RELOAD_RECONNECT=FAIL');
  console.error(error.stack || error.message);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
