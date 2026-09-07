const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const targetUrl = process.argv[2];
if (!targetUrl) {
  console.error('Usage: node browser-boot-test.js <player-url>');
  process.exit(2);
}

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileDir = path.join(__dirname, `.chrome-boot-test-${process.pid}`);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
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
    await delay(50);
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
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result || {});
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params?.exceptionDetails?.text || 'Runtime exception');
    }
  });

  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
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
  await send('Page.navigate', { url: targetUrl }, sessionId);

  await delay(7000);

  const evaluated = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      readyState: document.readyState,
      booted: window.__tttBooted === true,
      overlayTitle: document.getElementById('overlay-title')?.textContent || null,
      overlayMessage: document.getElementById('overlay-message')?.textContent || null,
      actionText: document.getElementById('overlay-action')?.textContent || null,
      actionHidden: document.getElementById('overlay-action')?.classList.contains('hidden') ?? true,
      bundleLoaded: Array.from(document.scripts).some((s) => /app\\.bundle\\.js(?:$|\\?)/.test(s.src)),
      moduleEntryLoaded: Array.from(document.scripts).some((s) => /js\\/main\\.js(?:$|\\?)/.test(s.src)),
    })`,
    returnByValue: true,
  }, sessionId);

  const result = JSON.parse(evaluated.result.value);
  assert.equal(result.readyState, 'complete', 'document did not finish loading');
  assert.equal(result.bundleLoaded, true, 'compatibility bundle script was not present');
  assert.equal(result.moduleEntryLoaded, false, 'legacy ES module entry is still being served');
  assert.equal(result.booted, true, `client bundle did not execute; overlay=${result.overlayTitle}`);
  assert.notEqual(result.overlayTitle, 'Game Failed to Load', 'boot watchdog fired');
  assert.equal(exceptions.length, 0, `runtime exceptions: ${exceptions.join('; ')}`);

  console.log(`BROWSER_BOOT=PASS title=${JSON.stringify(result.overlayTitle)} action=${JSON.stringify(result.actionText)}`);

  ws.close();
  chrome.kill();
  await delay(300);
  fs.rmSync(profileDir, { recursive: true, force: true });
})().catch(async (error) => {
  console.error('BROWSER_BOOT=FAIL');
  console.error(error.stack || error.message);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
