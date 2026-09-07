const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SIMLAB_URL = (process.env.SIMLAB_URL || 'https://app2.solarcal.xyz').replace(/\/$/, '');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileDir = path.join(__dirname, `.chrome-lazy-${process.pid}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startChrome() {
  fs.rmSync(profileDir, { recursive: true, force: true });
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=1280,900', 'about:blank',
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
  if (!devtoolsUrl) throw new Error('Timed out waiting for DevTools');

  const ws = new WebSocket(devtoolsUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id); pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result || {});
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    const message = { id, method, params }; if (sessionId) message.sessionId = sessionId;
    ws.send(JSON.stringify(message));
  });
  const { targetId } = await send('Target.createTarget', { url: SIMLAB_URL });
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.sessionId;
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'Runtime evaluation failed');
    return out.result?.value;
  };
  return { chrome, ws, send, sessionId, evaluate };
}

async function waitFor(evaluate, expression, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await wait(100); }
  throw new Error(`Timed out waiting for ${label}`);
}

(async () => {
  let browser;
  try {
    browser = await startChrome();
    await waitFor(browser.evaluate, `document.getElementById('human-vs-bot') && document.getElementById('config-status').textContent.indexOf('https://') >= 0`, 'SimLab ready');

    let state = JSON.parse(await browser.evaluate(`JSON.stringify({
      src: document.getElementById('game-frame').getAttribute('src'),
      hidden: document.getElementById('game-frame').hidden,
      frameDisplay: getComputedStyle(document.getElementById('game-frame')).display,
      placeholderHidden: document.getElementById('frame-placeholder').hidden,
      placeholderDisplay: getComputedStyle(document.getElementById('frame-placeholder')).display,
      showDisabled: document.getElementById('show-player').disabled,
      refreshDisabled: document.getElementById('refresh-player').disabled,
      openDisabled: document.getElementById('open-player').classList.contains('disabled')
    })`));
    assert.equal(state.src, 'about:blank');
    assert.equal(state.hidden, true);
    assert.equal(state.frameDisplay, 'none');
    assert.equal(state.placeholderHidden, false);
    assert.notEqual(state.placeholderDisplay, 'none');
    assert.equal(state.showDisabled, true);
    assert.equal(state.refreshDisabled, true);
    assert.equal(state.openDisabled, true);

    await browser.evaluate(`document.getElementById('human-vs-bot').click()`);
    await waitFor(browser.evaluate, `!document.getElementById('show-player').disabled && !document.getElementById('open-player').classList.contains('disabled')`, 'player choices ready');

    state = JSON.parse(await browser.evaluate(`JSON.stringify({
      src: document.getElementById('game-frame').getAttribute('src'),
      hidden: document.getElementById('game-frame').hidden,
      frameDisplay: getComputedStyle(document.getElementById('game-frame')).display,
      placeholderHidden: document.getElementById('frame-placeholder').hidden,
      refreshDisabled: document.getElementById('refresh-player').disabled,
      href: document.getElementById('open-player').href
    })`));
    assert.equal(state.src, 'about:blank', 'game auto-rendered before Show here');
    assert.equal(state.hidden, true);
    assert.equal(state.frameDisplay, 'none');
    assert.equal(state.placeholderHidden, false);
    assert.equal(state.refreshDisabled, true);
    assert.match(state.href, /\/session\/[^/]+\/join\?/);

    await browser.evaluate(`document.getElementById('show-player').click()`);
    await waitFor(browser.evaluate, `!document.getElementById('game-frame').hidden && getComputedStyle(document.getElementById('game-frame')).display !== 'none' && document.getElementById('frame-placeholder').hidden && !!document.getElementById('game-frame').getAttribute('src') && !document.getElementById('refresh-player').disabled`, 'embedded player shown');
    const srcBefore = await browser.evaluate(`document.getElementById('game-frame').getAttribute('src')`);
    await browser.evaluate(`document.getElementById('refresh-player').click()`);
    await wait(500);
    const srcAfter = await browser.evaluate(`document.getElementById('game-frame').getAttribute('src')`);
    assert.notEqual(srcAfter, srcBefore, 'Refresh WebView did not issue a fresh navigation');
    assert.match(srcAfter, /_simRefresh=\d+/);

    console.log('SIMLAB_LAZY_WEBVIEW=PASS autoRender=NO showHere=PASS refreshButton=PASS openNewTab=READY');
  } finally {
    if (browser) { try { browser.ws.close(); } catch {} try { browser.chrome.kill(); } catch {} await wait(250); }
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('SIMLAB_LAZY_WEBVIEW=FAIL');
  console.error(error.stack || error.message);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
