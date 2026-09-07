const $ = (id) => document.getElementById(id);

const state = {
  currentSessionId: null,
  playerUrl: null,
  lastLogId: 0,
  logPollInFlight: false,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function unloadEmbeddedPlayer(message) {
  const frame = $('game-frame');
  frame.hidden = true;
  frame.src = 'about:blank';
  $('refresh-player').disabled = true;
  $('frame-placeholder').hidden = false;
  if (message) $('frame-placeholder').textContent = message;
}

function loadEmbeddedPlayer() {
  if (!state.playerUrl) return;
  const frame = $('game-frame');
  frame.src = state.playerUrl;
  frame.hidden = false;
  $('frame-placeholder').hidden = true;
  $('refresh-player').disabled = false;
}

function refreshEmbeddedPlayer() {
  const frame = $('game-frame');
  if (!state.playerUrl || frame.hidden) return;
  const url = new URL(state.playerUrl);
  url.searchParams.set('_simRefresh', String(Date.now()));
  frame.src = url.toString();
}

function setCurrentSession(session, player = null) {
  state.currentSessionId = session?.sessionId || null;
  state.playerUrl = player?.playerUrl || null;
  $('end-current').disabled = !state.currentSessionId;

  if (!session) {
    $('current-session').className = 'session-card muted';
    $('current-session').textContent = 'No scenario loaded.';
  } else {
    $('current-session').className = 'session-card';
    $('current-session').innerHTML = `
      <strong>${escapeHtml(session.sessionId)}</strong><br>
      <span class="muted">Join URL: ${escapeHtml(session.joinUrl || 'n/a')}</span>
    `;
  }

  // Never auto-render the player. A scenario only prepares the player URL;
  // the tester explicitly chooses either the embedded WebView or a new tab.
  unloadEmbeddedPlayer();

  if (state.playerUrl) {
    $('frame-placeholder').textContent = 'Player URL is ready. Choose “Show here” or “Open in new tab”.';
    $('show-player').disabled = false;
    $('open-player').href = state.playerUrl;
    $('open-player').classList.remove('disabled');
  } else {
    $('frame-placeholder').textContent = 'Create a Human vs Bot scenario, then choose “Show here” or “Open in new tab”.';
    $('show-player').disabled = true;
    $('open-player').removeAttribute('href');
    $('open-player').classList.add('disabled');
  }
}

async function loadConfig() {
  try {
    const config = await api('/api/config');
    const pill = $('config-status');
    pill.textContent = `${config.gameServerUrl} · token ${config.tokenConfigured ? 'configured' : 'missing'}`;
    pill.className = `status-pill ${config.tokenConfigured ? 'good' : 'bad'}`;
  } catch (error) {
    $('config-status').textContent = error.message;
    $('config-status').className = 'status-pill bad';
  }
}

async function createHumanVsBot() {
  const data = await api('/api/scenarios/human-vs-bot', {
    method: 'POST',
    body: JSON.stringify({
      humanName: $('human-name').value,
      botName: $('bot-name').value,
      turnDurationSec: Number($('turn-duration').value) || 10,
    }),
  });
  setCurrentSession(data.session, data.player);
  await refreshState();
}

async function createBotVsBot() {
  const data = await api('/api/scenarios/bot-vs-bot', {
    method: 'POST',
    body: JSON.stringify({
      botAName: 'Bot A',
      botBName: 'Bot B',
      turnDurationSec: Number($('turn-duration').value) || 10,
    }),
  });
  setCurrentSession(data.session);
  await refreshState();
}

async function createEmptySession() {
  const session = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ turnDurationSec: Number($('turn-duration').value) || 10 }),
  });
  setCurrentSession(session);
  await refreshState();
}

async function endCurrentSession() {
  if (!state.currentSessionId) return;
  await api(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/end`, { method: 'POST' });
  await refreshState();
}

async function loadBots() {
  const bots = await api('/api/bots');
  $('bot-count').textContent = bots.length;
  const root = $('bots');
  root.innerHTML = '';

  if (!bots.length) {
    root.innerHTML = '<div class="muted">No bots running.</div>';
    return;
  }

  for (const bot of bots) {
    const node = $('bot-template').content.firstElementChild.cloneNode(true);
    node.querySelector('.card-title').textContent = `${bot.playerName} · ${bot.status}`;
    node.querySelector('.card-meta').innerHTML = `
      playerId: ${escapeHtml(bot.playerId)}<br>
      session: ${escapeHtml(bot.sessionId)}<br>
      socket: ${bot.connected ? 'connected' : 'disconnected'} · ready: ${bot.ready ? 'yes' : 'no'} · symbol: ${escapeHtml(bot.symbol || '—')}
    `;
    node.querySelector('[data-action="disconnect"]').onclick = async () => {
      await api(`/api/bots/${bot.botId}/disconnect`, { method: 'POST' });
      await refreshState();
    };
    node.querySelector('[data-action="reconnect"]').onclick = async () => {
      await api(`/api/bots/${bot.botId}/reconnect`, { method: 'POST' });
      await refreshState();
    };
    node.querySelector('[data-action="remove"]').onclick = async () => {
      await api(`/api/bots/${bot.botId}`, { method: 'DELETE' });
      await refreshState();
    };
    root.appendChild(node);
  }
}

async function loadSessions() {
  try {
    const sessions = await api('/api/sessions');
    $('session-count').textContent = sessions.length;
    const root = $('sessions');
    root.innerHTML = '';

    if (!sessions.length) {
      root.innerHTML = '<div class="muted">No active sessions.</div>';
      return;
    }

    for (const session of sessions) {
      const card = document.createElement('article');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-title">${escapeHtml(session.status)} · ${escapeHtml(session.sessionId)}</div>
        <div class="card-meta">
          players: ${session.players?.length || 0} · turn: ${escapeHtml(session.currentTurnPlayerId || '—')} · turnCount: ${session.turnCount ?? 0}<br>
          created: ${escapeHtml(session.createdAt || '—')}
        </div>
      `;
      root.appendChild(card);
    }
  } catch (error) {
    $('session-count').textContent = '!';
    $('sessions').innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`;
  }
}

async function pollLogs() {
  // Never allow overlapping polls. Two in-flight requests can read the same
  // `after` value and append the same entries twice to the dashboard.
  if (state.logPollInFlight) return;
  state.logPollInFlight = true;
  try {
    const entries = await api(`/api/logs?after=${state.lastLogId}`);
    if (!entries.length) return;
    const root = $('logs');
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80;

    entries.sort((a, b) => a.id - b.id);
    for (const entry of entries) {
      if (entry.id <= state.lastLogId) continue;
      state.lastLogId = entry.id;
      const row = document.createElement('div');
      row.className = `log-row ${entry.level}`;
      const time = new Date(entry.at).toLocaleTimeString();
      const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
      row.textContent = `${time} [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}${meta}`;
      root.appendChild(row);
    }

    while (root.children.length > 700) root.firstElementChild.remove();
    if (nearBottom) root.scrollTop = root.scrollHeight;
  } catch {
    // Polling should not disrupt the test page if SimLab briefly restarts.
  } finally {
    state.logPollInFlight = false;
  }
}

async function refreshState() {
  await Promise.allSettled([loadBots(), loadSessions(), loadConfig()]);
}

async function safeAction(action) {
  try {
    await action();
  } catch (error) {
    window.alert(error.message);
  }
}

$('human-vs-bot').onclick = () => safeAction(createHumanVsBot);
$('show-player').onclick = loadEmbeddedPlayer;
$('refresh-player').onclick = refreshEmbeddedPlayer;
$('open-player').addEventListener('click', () => {
  // Opening in a new tab must never leave an embedded copy running too. Use
  // about:blank rather than only removing src, because some WebViews keep the
  // previous document/audio alive until a real navigation occurs.
  unloadEmbeddedPlayer('Player opened in a new tab. Embedded WebView is unloaded.');
});
$('bot-vs-bot').onclick = () => safeAction(createBotVsBot);
$('create-empty').onclick = () => safeAction(createEmptySession);
$('end-current').onclick = () => safeAction(endCurrentSession);
$('refresh-all').onclick = () => safeAction(refreshState);
$('clear-logs').onclick = () => safeAction(async () => {
  await api('/api/logs', { method: 'DELETE' });
  $('logs').innerHTML = '';
  state.lastLogId = 0;
});

setCurrentSession(null);
await refreshState();
await pollLogs();
setInterval(refreshState, 1500);
setInterval(pollLogs, 500);
