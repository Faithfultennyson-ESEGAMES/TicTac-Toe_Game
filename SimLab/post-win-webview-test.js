const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { io } = require('socket.io-client');

const SIMLAB_URL = (process.env.SIMLAB_URL || 'https://app2.solarcal.xyz').replace(/\/$/, '');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileDir = path.join(__dirname, `.chrome-post-win-${process.pid}`);

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

async function startChrome() {
  fs.rmSync(profileDir, { recursive: true, force: true });
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--window-size=390,844',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let devtoolsUrl = null;
  let stderr = '';
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) devtoolsUrl = match[1];
  });

  const deadline = Date.now() + 10000;
  while (!devtoolsUrl && Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited early with ${chrome.exitCode}`);
    await wait(50);
  }
  if (!devtoolsUrl) throw new Error('Timed out waiting for Chrome DevTools endpoint');

  const ws = new WebSocket(devtoolsUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let nextId = 1;
  const pending = new Map();
  const exceptions = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result || {});
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params?.exceptionDetails?.text || 'Runtime exception');
    }
  });

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    ws.send(JSON.stringify(message));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.sessionId;
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'Runtime evaluation failed');
    return out.result?.value;
  };

  return { chrome, ws, sessionId, send, evaluate, exceptions };
}

async function waitFor(evaluate, expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

(async () => {
  const config = await api('/api/config');
  const created = await api('/api/sessions', { method: 'POST', body: { turnDurationSec: 30 } });
  const sessionId = created.sessionId;
  const playerA = `ux-a-${Date.now()}`;
  const playerB = `ux-b-${Date.now()}`;
  const joinUrl = new URL(created.joinUrl);
  joinUrl.searchParams.set('playerId', playerA);
  joinUrl.searchParams.set('playerName', 'UX A');

  let browser;
  let b;
  try {
    browser = await startChrome();
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const NativeAudio = window.Audio;
        window.__tttAudioElements = [];
        function TrackedAudio(...args) {
          const el = new NativeAudio(...args);
          window.__tttAudioElements.push(el);
          return el;
        }
        TrackedAudio.prototype = NativeAudio.prototype;
        Object.setPrototypeOf(TrackedAudio, NativeAudio);
        window.Audio = TrackedAudio;
      })();`,
    }, browser.sessionId);
    await browser.send('Page.navigate', { url: joinUrl.toString() }, browser.sessionId);

    await waitFor(
      browser.evaluate,
      `window.__tttBooted === true && document.getElementById('overlay-title')?.textContent === 'Waiting for Opponent'`,
      'first player lobby',
    );

    // Verify the mute button actually changes persisted state and UI in the
    // hardened browser bundle.
    await browser.evaluate(`document.getElementById('mute-btn').click()`);
    await wait(100);
    let muteState = JSON.parse(await browser.evaluate(`JSON.stringify({
      pressed: document.getElementById('mute-btn').getAttribute('aria-pressed'),
      stored: localStorage.getItem('ttt.muted'),
      icon: document.getElementById('mute-icon').getAttribute('src'),
      fallbackCount: window.__tttAudioElements?.length || 0,
      allFallbackMuted: (window.__tttAudioElements || []).every((el) => el.muted === true)
    })`));
    assert.equal(muteState.pressed, 'true');
    assert.equal(muteState.stored, '1');
    assert.match(muteState.icon, /speaker_off\.svg$/);
    assert(muteState.fallbackCount > 0, 'audio fallback elements were not created');
    assert.equal(muteState.allFallbackMuted, true, 'mute did not cover HTMLAudio fallbacks');

    await browser.evaluate(`document.getElementById('mute-btn').click()`);
    await wait(100);
    muteState = JSON.parse(await browser.evaluate(`JSON.stringify({
      pressed: document.getElementById('mute-btn').getAttribute('aria-pressed'),
      stored: localStorage.getItem('ttt.muted'),
      icon: document.getElementById('mute-icon').getAttribute('src'),
      allFallbackUnmuted: (window.__tttAudioElements || []).every((el) => el.muted === false)
    })`));
    assert.equal(muteState.pressed, 'false');
    assert.equal(muteState.stored, '0');
    assert.match(muteState.icon, /speaker_on\.svg$/);
    assert.equal(muteState.allFallbackUnmuted, true, 'unmute did not restore HTMLAudio fallbacks');

    b = io(config.gameServerUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: false,
    });
    if (!b.connected) await once(b, 'connect');
    const joinAck = await new Promise((resolve) => {
      b.emit('join', { sessionId, playerId: playerB, playerName: 'UX B' }, resolve);
    });
    assert.equal(joinAck?.success, true, `B join failed: ${JSON.stringify(joinAck)}`);

    await waitFor(
      browser.evaluate,
      `document.getElementById('overlay-title')?.textContent === 'Ready to Play?'`,
      'browser Ready prompt',
    );

    await browser.evaluate(`document.getElementById('overlay-action').click()`);
    const readyB = once(b, 'ready-confirmed');
    b.emit('player-ready', { sessionId, playerId: playerB });
    await readyB;

    await waitFor(
      browser.evaluate,
      `!document.getElementById('board-wrapper').classList.contains('hidden') && document.getElementById('overlay').classList.contains('hidden')`,
      'active board',
    );

    const waitForMoveTo = async (expectedPlayerId) => {
      while (true) {
        const payload = await once(b, 'move-applied');
        if (payload?.currentTurnPlayerId === expectedPlayerId || payload?.currentTurnPlayerId === null) return payload;
      }
    };

    // Deterministic X win: X 0,1,2 and O 3,4.
    await browser.evaluate(`document.querySelector('.board-cell[data-index="0"]').click()`);
    await waitForMoveTo(playerB);

    b.emit('make-move', { sessionId, playerId: playerB, position: 3 });
    await waitForMoveTo(playerA);

    await browser.evaluate(`document.querySelector('.board-cell[data-index="1"]').click()`);
    await waitForMoveTo(playerB);

    b.emit('make-move', { sessionId, playerId: playerB, position: 4 });
    await waitForMoveTo(playerA);

    const ended = once(b, 'game-ended');
    await browser.evaluate(`document.querySelector('.board-cell[data-index="2"]').click()`);
    const endPayload = await ended;
    assert.equal(endPayload.reason, 'win');

    await wait(700);
    let ui = JSON.parse(await browser.evaluate(`JSON.stringify({
      boardHidden: document.getElementById('board-wrapper').classList.contains('hidden'),
      overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
      turn: document.getElementById('turn-text').textContent,
      toast: document.querySelector('.toast')?.textContent || '',
      toastShown: document.querySelector('.toast')?.classList.contains('show') || false
    })`));
    assert.equal(ui.boardHidden, false, 'final board was hidden immediately');
    assert.equal(ui.overlayHidden, true, 'end overlay appeared before the hold finished');
    assert.equal(ui.turn, 'Game Ended');
    assert.equal(ui.toast, 'Game Ended');
    assert.equal(ui.toastShown, true);

    await wait(5200);
    ui = JSON.parse(await browser.evaluate(`JSON.stringify({
      boardHidden: document.getElementById('board-wrapper').classList.contains('hidden'),
      overlayHidden: document.getElementById('overlay').classList.contains('hidden')
    })`));
    assert.equal(ui.boardHidden, false, 'final board did not remain visible during the 7-second hold');
    assert.equal(ui.overlayHidden, true, 'end overlay appeared too early');

    await wait(1800);
    ui = JSON.parse(await browser.evaluate(`JSON.stringify({
      boardHidden: document.getElementById('board-wrapper').classList.contains('hidden'),
      overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
      overlayTitle: document.getElementById('overlay-title').textContent
    })`));
    assert.equal(ui.boardHidden, true, 'final board remained visible after the hold');
    assert.equal(ui.overlayHidden, false, 'final end screen did not appear after the hold');
    assert.equal(ui.overlayTitle, 'Game Ended');
    assert.equal(browser.exceptions.length, 0, `runtime exceptions: ${browser.exceptions.join('; ')}`);

    console.log('POST_WIN_WEBVIEW=PASS mute=PASS final_board_hold=7s');
  } finally {
    b?.disconnect();
    if (browser) {
      try { browser.ws.close(); } catch {}
      try { browser.chrome.kill(); } catch {}
      await wait(250);
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST' });
    } catch {}
  }
})().catch((error) => {
  console.error('POST_WIN_WEBVIEW=FAIL');
  console.error(error.stack || error.message);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
