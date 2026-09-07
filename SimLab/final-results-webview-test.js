const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { io } = require('socket.io-client');

const SIMLAB_URL = (process.env.SIMLAB_URL || 'https://app2.solarcal.xyz').replace(/\/$/, '');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BROWSER_OUTCOME = process.env.BROWSER_OUTCOME === 'lose' ? 'lose' : 'win';
const profileDir = path.join(__dirname, `.chrome-final-results-${process.pid}`);
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
  if (!devtoolsUrl) throw new Error('Timed out waiting for Chrome DevTools endpoint');

  const ws = new WebSocket(devtoolsUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let nextId = 1;
  const pending = new Map();
  const exceptions = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result || {});
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params?.exceptionDetails?.text || 'Runtime exception');
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    const message = { id, method, params }; if (sessionId) message.sessionId = sessionId; ws.send(JSON.stringify(message));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.sessionId;
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__tttTestAudio = { oscillators: 0, bufferStarts: [] };
    (function(){
      var origOsc = window.AudioContext && AudioContext.prototype.createOscillator;
      if (origOsc) AudioContext.prototype.createOscillator = function(){ window.__tttTestAudio.oscillators++; return origOsc.apply(this, arguments); };
      var origBS = window.AudioContext && AudioContext.prototype.createBufferSource;
      if (origBS) AudioContext.prototype.createBufferSource = function(){
        var node = origBS.apply(this, arguments); var start = node.start;
        node.start = function(){ try { window.__tttTestAudio.bufferStarts.push(node.buffer ? node.buffer.duration : null); } catch(e){} return start.apply(node, arguments); };
        return node;
      };
    })();
  ` }, sessionId);
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'Runtime evaluation failed');
    return out.result?.value;
  };
  return { chrome, ws, sessionId, send, evaluate, exceptions };
}

async function waitFor(evaluate, expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await wait(100); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function realClick(browser, selector) {
  const rect = JSON.parse(await browser.evaluate(`JSON.stringify((function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })())`));
  if (!rect) throw new Error(`Could not find ${selector}`);
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, browser.sessionId);
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, browser.sessionId);
}

(async () => {
  const config = await api('/api/config');
  const created = await api('/api/sessions', { method: 'POST', body: { turnDurationSec: 30 } });
  const sessionId = created.sessionId;
  const playerA = `browser-${Date.now()}`;
  const playerB = `socket-${Date.now()}`;
  const browserWins = BROWSER_OUTCOME === 'win';
  const browserName = browserWins ? 'Winner Test' : 'Loser Test';
  const opponentName = browserWins ? 'Loser Test' : 'Winner Test';
  const expectedWinnerId = browserWins ? playerA : playerB;
  const expectedWinnerName = browserWins ? browserName : opponentName;
  const expectedLoserName = browserWins ? opponentName : browserName;
  const joinUrl = new URL(created.joinUrl);
  joinUrl.searchParams.set('playerId', playerA);
  joinUrl.searchParams.set('playerName', browserName);

  let browser; let b;
  try {
    browser = await startChrome();
    await browser.send('Page.navigate', { url: joinUrl.toString() }, browser.sessionId);
    await waitFor(browser.evaluate, `window.__tttBooted === true && document.getElementById('overlay-title')?.textContent === 'Waiting for Opponent'`, 'first lobby');

    // First interactive tap should produce the preloaded UI click sound after
    // WebAudio unlock. The same click asset also has an HTMLAudio fallback.
    const beforeClickStarts = JSON.parse(await browser.evaluate(`JSON.stringify(window.__tttTestAudio.bufferStarts || [])`)).length;
    await realClick(browser, '#mute-btn');
    await wait(450);
    const afterClickStarts = JSON.parse(await browser.evaluate(`JSON.stringify(window.__tttTestAudio.bufferStarts || [])`)).length;
    assert(afterClickStarts > beforeClickStarts, 'UI click sound did not start after unlock');

    b = io(config.gameServerUrl, { path: '/socket.io', transports: ['websocket', 'polling'], reconnection: false });
    if (!b.connected) await once(b, 'connect');
    const joinAck = await new Promise((resolve) => b.emit('join', { sessionId, playerId: playerB, playerName: opponentName }, resolve));
    assert.equal(joinAck?.success, true);
    await waitFor(browser.evaluate, `document.getElementById('overlay-title')?.textContent === 'Ready to Play?'`, 'Ready prompt');
    await browser.evaluate(`document.getElementById('overlay-action').click()`);
    const readyB = once(b, 'ready-confirmed'); b.emit('player-ready', { sessionId, playerId: playerB }); await readyB;
    await waitFor(browser.evaluate, `!document.getElementById('board-wrapper').classList.contains('hidden') && document.getElementById('overlay').classList.contains('hidden')`, 'board active');

    const waitForMoveTo = async (expected) => { while (true) { const p = await once(b, 'move-applied'); if (p?.currentTurnPlayerId === expected || p?.currentTurnPlayerId === null) return p; } };
    await waitFor(browser.evaluate, `document.getElementById('turn-text')?.textContent === 'X turn'`, 'X first turn');
    await browser.evaluate(`document.querySelector('.board-cell[data-index="0"]').click()`); await waitForMoveTo(playerB);
    b.emit('make-move', { sessionId, playerId: playerB, position: 3 }); await waitForMoveTo(playerA);
    await waitFor(browser.evaluate, `document.getElementById('turn-text')?.textContent === 'X turn'`, 'X second turn');
    await browser.evaluate(`document.querySelector('.board-cell[data-index="1"]').click()`); await waitForMoveTo(playerB);
    b.emit('make-move', { sessionId, playerId: playerB, position: 4 }); await waitForMoveTo(playerA);
    await waitFor(browser.evaluate, `document.getElementById('turn-text')?.textContent === 'X turn'`, 'X third turn');

    let endPayload;
    const beforeResultStarts = JSON.parse(await browser.evaluate(`JSON.stringify(window.__tttTestAudio.bufferStarts || [])`)).length;
    if (browserWins) {
      const ended = once(b, 'game-ended');
      await browser.evaluate(`document.querySelector('.board-cell[data-index="2"]').click()`);
      endPayload = await ended;
    } else {
      await browser.evaluate(`document.querySelector('.board-cell[data-index="8"]').click()`); await waitForMoveTo(playerB);
      const ended = once(b, 'game-ended');
      b.emit('make-move', { sessionId, playerId: playerB, position: 5 });
      endPayload = await ended;
    }
    assert.equal(endPayload.reason, 'win');
    assert.equal(endPayload.winnerPlayerId, expectedWinnerId);
    assert.equal(endPayload.players.length, 2);

    await wait(800);
    const banner = JSON.parse(await browser.evaluate(`JSON.stringify({
      title: document.getElementById('overlay-title').textContent,
      message: document.getElementById('overlay-message').textContent,
      banner: document.getElementById('overlay').classList.contains('banner'),
      boardHidden: document.getElementById('board-wrapper').classList.contains('hidden')
    })`));
    assert.equal(banner.title, 'Game Ended');
    assert.equal(banner.banner, true);
    assert.equal(banner.boardHidden, false);
    assert.match(banner.message, new RegExp(`Winner: ${expectedWinnerName}`));
    assert.match(banner.message, new RegExp(`Loser: ${expectedLoserName}`));

    const afterResultStarts = JSON.parse(await browser.evaluate(`JSON.stringify(window.__tttTestAudio.bufferStarts || [])`)).length;
    assert(afterResultStarts > beforeResultStarts, `${browserWins ? 'winner' : 'loser'} result sound did not start`);

    await wait(6800);
    const final = JSON.parse(await browser.evaluate(`JSON.stringify({
      title: document.getElementById('overlay-title').textContent,
      resultsMode: document.getElementById('overlay').classList.contains('results'),
      boardHidden: document.getElementById('board-wrapper').classList.contains('hidden'),
      rows: Array.from(document.querySelectorAll('#end-leaderboard .leaderboard-row')).map((row) => ({
        text: row.textContent,
        winner: row.classList.contains('winner'),
        loser: row.classList.contains('loser'),
        background: getComputedStyle(row).backgroundColor,
        border: getComputedStyle(row).borderColor,
        display: getComputedStyle(row).display
      }))
    })`));
    assert.equal(final.title, 'Match Results');
    assert.equal(final.resultsMode, true);
    assert.equal(final.boardHidden, true);
    assert.equal(final.rows.length, 2);
    assert.equal(final.rows[0].winner, true);
    assert.equal(final.rows[0].display, 'grid');
    assert.match(final.rows[0].text, new RegExp(expectedWinnerName));
    assert.match(final.rows[0].text, /WINNER/);
    assert.equal(final.rows[1].loser, true);
    assert.equal(final.rows[1].display, 'grid');
    assert.match(final.rows[1].text, new RegExp(expectedLoserName));
    assert.match(final.rows[1].text, /LOSER/);
    assert.notEqual(final.rows[0].background, final.rows[1].background, 'winner/loser rows are not visually separated');
    assert.notEqual(final.rows[0].border, final.rows[1].border, 'winner/loser result colors are not distinct');
    assert.equal(browser.exceptions.length, 0, `runtime exceptions: ${browser.exceptions.join('; ')}`);

    console.log(`FINAL_RESULTS_WEBVIEW=PASS browserOutcome=${BROWSER_OUTCOME} banner=winner+loser leaderboard=2rows resultSound=PASS uiClick=PASS`);
  } finally {
    b?.disconnect();
    if (browser) { try { browser.ws.close(); } catch {} try { browser.chrome.kill(); } catch {} await wait(250); }
    fs.rmSync(profileDir, { recursive: true, force: true });
    try { await api(`/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST' }); } catch {}
  }
})().catch((error) => {
  console.error('FINAL_RESULTS_WEBVIEW=FAIL'); console.error(error.stack || error.message);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
