const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { io } = require('socket.io-client');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();

const PORT = Number.parseInt(process.env.SIMLAB_PORT, 10) || 4100;
const GAME_SERVER_URL = (process.env.GAME_SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const GAME_SERVER_TOKEN = process.env.GAME_SERVER_TOKEN || '';
const BOT_MOVE_DELAY_MS = Number.parseInt(process.env.BOT_MOVE_DELAY_MS, 10) || 700;
const BOT_READY_RETRY_MS = Number.parseInt(process.env.BOT_READY_RETRY_MS, 10) || 1500;
const BOT_READY_MAX_ATTEMPTS = Number.parseInt(process.env.BOT_READY_MAX_ATTEMPTS, 10) || 12;
const LOG_LIMIT = Number.parseInt(process.env.LOG_LIMIT, 10) || 1000;

const bots = new Map();
const logs = [];
let logSequence = 0;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

function log(level, source, message, meta = null) {
  const entry = {
    id: ++logSequence,
    at: new Date().toISOString(),
    level,
    source,
    message,
    meta,
  };
  logs.push(entry);
  while (logs.length > LOG_LIMIT) logs.shift();
  const detail = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[${entry.at}] [${level.toUpperCase()}] [${source}] ${message}${detail}`);
  return entry;
}

app.post('/webhook', (req, res) => {
  log('info', 'webhook', 'Webhook received from game server', req.body || {});
  res.status(204).end();
});

function publicBot(bot) {
  return {
    botId: bot.botId,
    sessionId: bot.sessionId,
    playerId: bot.playerId,
    playerName: bot.playerName,
    status: bot.status,
    connected: bot.connected,
    ready: bot.ready,
    symbol: bot.symbol,
    currentTurnPlayerId: bot.currentTurnPlayerId,
    autoReady: bot.autoReady,
    createdAt: bot.createdAt,
  };
}

async function gameRequest(route, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (GAME_SERVER_TOKEN) headers.Authorization = `Bearer ${GAME_SERVER_TOKEN}`;

  const response = await fetch(`${GAME_SERVER_URL}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message = data?.error || data?.message || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return data;
}

async function createGameSession(turnDurationSec = 10) {
  const payload = await gameRequest('/start', {
    method: 'POST',
    body: { turnDurationSec },
  });
  log('info', 'session', 'Session created', payload);
  return payload;
}

function buildPlayerUrl(joinUrl, playerId, playerName) {
  const url = new URL(joinUrl, GAME_SERVER_URL);
  url.searchParams.set('playerId', playerId);
  url.searchParams.set('playerName', playerName);
  return url.toString();
}

function clearBotTimers(bot) {
  clearInterval(bot.readyTimer);
  clearTimeout(bot.moveTimer);
  bot.readyTimer = null;
  bot.moveTimer = null;
}

function stopReadyRetry(bot) {
  clearInterval(bot.readyTimer);
  bot.readyTimer = null;
  bot.readyAttempts = 0;
}

function startReadyRetry(bot) {
  if (!bot.autoReady || bot.ready || bot.readyTimer || !bot.socket) return;

  const sendReady = () => {
    if (bot.ready || !bot.socket) {
      stopReadyRetry(bot);
      return;
    }

    if (bot.readyAttempts >= BOT_READY_MAX_ATTEMPTS) {
      log('error', `bot:${bot.playerName}`, 'Ready was not confirmed before retry limit', {
        attempts: bot.readyAttempts,
      });
      stopReadyRetry(bot);
      bot.status = 'ready-unconfirmed';
      return;
    }

    bot.readyAttempts += 1;
    bot.socket.emit('player-ready', {
      sessionId: bot.sessionId,
      playerId: bot.playerId,
    });
    log('debug', `bot:${bot.playerName}`, 'Sent Ready', { attempt: bot.readyAttempts });
  };

  sendReady();
  bot.readyTimer = setInterval(sendReady, BOT_READY_RETRY_MS);
}

function chooseBotMove(bot) {
  if (!bot.symbol || !Array.isArray(bot.board)) return null;
  const empty = bot.board
    .map((value, index) => (value === null ? index : null))
    .filter((value) => value !== null);

  if (!empty.length) return null;

  const own = bot.board
    .map((value, index) => (value === bot.symbol ? index : null))
    .filter((value) => value !== null);

  const pick = (items) => items[Math.floor(Math.random() * items.length)];

  if (own.length < 3) {
    return { event: 'make-move', payload: { position: pick(empty) } };
  }

  return {
    event: 'relocate-move',
    payload: {
      from: pick(own),
      to: pick(empty),
    },
  };
}

function scheduleBotMove(bot) {
  if (bot.status !== 'active' || !bot.connected || bot.currentTurnPlayerId !== bot.playerId || bot.moveTimer) {
    return;
  }

  bot.moveTimer = setTimeout(() => {
    bot.moveTimer = null;
    if (bot.status !== 'active' || !bot.connected || bot.currentTurnPlayerId !== bot.playerId) return;

    const move = chooseBotMove(bot);
    if (!move) return;

    const payload = {
      sessionId: bot.sessionId,
      playerId: bot.playerId,
      ...move.payload,
    };
    bot.socket.emit(move.event, payload);
    log('info', `bot:${bot.playerName}`, `Sent ${move.event}`, payload);
  }, BOT_MOVE_DELAY_MS);
}

function attachBotSocket(bot) {
  const socket = io(GAME_SERVER_URL, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2500,
    reconnectionAttempts: Infinity,
  });

  bot.socket = socket;
  bot.status = 'connecting';

  socket.on('connect', () => {
    if (bot.status === 'ended') {
      socket.io.opts.reconnection = false;
      socket.disconnect();
      return;
    }
    bot.connected = true;
    bot.status = bot.status === 'active' ? 'active' : 'joined';
    log('info', `bot:${bot.playerName}`, 'Socket connected', { socketId: socket.id });

    socket.emit('join', {
      sessionId: bot.sessionId,
      playerId: bot.playerId,
      playerName: bot.playerName,
      reconnectToken: bot.reconnectToken || null,
    }, (ack) => {
      if (ack?.success) {
        if (ack.reconnectToken) bot.reconnectToken = ack.reconnectToken;
        log('info', `bot:${bot.playerName}`, 'Join acknowledged', {
          success: true,
          status: ack.status,
          playerId: ack.playerId,
          reconnectTokenIssued: Boolean(ack.reconnectToken),
        });
      } else {
        log('error', `bot:${bot.playerName}`, 'Join rejected', ack || {});
      }
    });
  });

  socket.on('disconnect', (reason) => {
    bot.connected = false;
    clearTimeout(bot.moveTimer);
    bot.moveTimer = null;
    if (bot.status === 'ended') return;
    bot.status = 'disconnected';
    log('warn', `bot:${bot.playerName}`, 'Socket disconnected', { reason });
  });

  socket.on('connect_error', (error) => {
    if (bot.status === 'ended') return;
    log('error', `bot:${bot.playerName}`, 'Socket connection error', { message: error.message });
  });

  socket.on('join-error', (payload) => {
    bot.status = 'join-error';
    log('error', `bot:${bot.playerName}`, 'Join error', payload);
  });

  socket.on('waiting-for-player', () => {
    if (bot.status !== 'active') bot.status = 'waiting';
    log('debug', `bot:${bot.playerName}`, 'Waiting for another player');
  });

  socket.on('lobby-state', (state = {}) => {
    const me = Array.isArray(state.players)
      ? state.players.find((player) => player.playerId === bot.playerId)
      : null;

    bot.ready = Boolean(me?.ready);
    if (bot.ready) {
      bot.status = state.status === 'active' ? 'active' : 'ready';
      stopReadyRetry(bot);
    }

    log('debug', `bot:${bot.playerName}`, 'Lobby state received', {
      status: state.status,
      players: state.players?.map((player) => ({ playerId: player.playerId, ready: player.ready })),
    });

    if (state.status === 'pending' && state.players?.length === 2 && !bot.ready) {
      startReadyRetry(bot);
    }
  });

  socket.on('ready-confirmed', (payload) => {
    if (payload?.playerId !== bot.playerId) return;
    bot.ready = true;
    bot.status = 'ready';
    stopReadyRetry(bot);
    log('info', `bot:${bot.playerName}`, 'Ready confirmed by server');
  });

  socket.on('ready-error', (payload) => {
    log('warn', `bot:${bot.playerName}`, 'Ready rejected', payload);
  });

  socket.on('game-found', (session = {}) => {
    bot.status = 'active';
    bot.ready = true;
    bot.board = Array.isArray(session.board) ? [...session.board] : Array(9).fill(null);
    bot.currentTurnPlayerId = session.currentTurnPlayerId || null;
    const me = Array.isArray(session.players)
      ? session.players.find((player) => player.playerId === bot.playerId)
      : null;
    bot.symbol = me?.symbol || bot.symbol;
    stopReadyRetry(bot);
    log('info', `bot:${bot.playerName}`, 'Game started', {
      symbol: bot.symbol,
      currentTurnPlayerId: bot.currentTurnPlayerId,
    });
    scheduleBotMove(bot);
  });

  socket.on('turn-started', ({ currentTurnPlayerId } = {}) => {
    bot.currentTurnPlayerId = currentTurnPlayerId || null;
    log('debug', `bot:${bot.playerName}`, 'Turn started', { currentTurnPlayerId });
    scheduleBotMove(bot);
  });

  socket.on('move-applied', ({ board, currentTurnPlayerId } = {}) => {
    if (Array.isArray(board)) bot.board = [...board];
    bot.currentTurnPlayerId = currentTurnPlayerId || null;
    log('debug', `bot:${bot.playerName}`, 'Move applied', {
      board: bot.board,
      currentTurnPlayerId: bot.currentTurnPlayerId,
    });
    scheduleBotMove(bot);
  });

  socket.on('move-error', (payload) => {
    log('warn', `bot:${bot.playerName}`, 'Move rejected', payload);
    scheduleBotMove(bot);
  });

  socket.on('player-disconnected', (payload) => {
    log('warn', `bot:${bot.playerName}`, 'Other player disconnected', payload);
  });

  socket.on('player-reconnected', (payload) => {
    log('info', `bot:${bot.playerName}`, 'Player reconnected', payload);
  });

  const onEnded = (payload, source) => {
    if (bot.status === 'ended') return;
    bot.status = 'ended';
    bot.currentTurnPlayerId = null;
    clearBotTimers(bot);
    log('info', `bot:${bot.playerName}`, `Session ended via ${source}`, payload);

    // An ended test bot has nothing left to recover. Disable Socket.IO's
    // automatic reconnect so a later game-server restart does not make this
    // bot repeatedly try to join a session that has already been deleted.
    socket.io.opts.reconnection = false;
    if (socket.connected) socket.disconnect();
    bot.connected = false;
  };

  socket.on('game-ended', (payload) => onEnded(payload, 'game-ended'));
  socket.on('session-ended', (payload) => onEnded(payload, 'session-ended'));
}

function createBot({ sessionId, playerName, playerId, autoReady = true }) {
  const botId = crypto.randomUUID();
  const bot = {
    botId,
    sessionId,
    playerId: playerId || `bot-${crypto.randomUUID()}`,
    playerName: playerName || `Bot-${botId.slice(0, 4)}`,
    autoReady,
    socket: null,
    connected: false,
    ready: false,
    readyTimer: null,
    readyAttempts: 0,
    moveTimer: null,
    symbol: null,
    board: Array(9).fill(null),
    currentTurnPlayerId: null,
    status: 'created',
    reconnectToken: null,
    createdAt: new Date().toISOString(),
  };
  bots.set(botId, bot);
  attachBotSocket(bot);
  return bot;
}

app.get('/api/config', (req, res) => {
  res.json({
    simLabPort: PORT,
    gameServerUrl: GAME_SERVER_URL,
    tokenConfigured: Boolean(GAME_SERVER_TOKEN),
    botMoveDelayMs: BOT_MOVE_DELAY_MS,
    botReadyRetryMs: BOT_READY_RETRY_MS,
    botReadyMaxAttempts: BOT_READY_MAX_ATTEMPTS,
  });
});

app.get('/api/logs', (req, res) => {
  const after = Number.parseInt(req.query.after, 10) || 0;
  res.json(logs.filter((entry) => entry.id > after));
});

app.delete('/api/logs', (req, res) => {
  logs.length = 0;
  res.status(204).end();
});

app.get('/api/bots', (req, res) => {
  res.json(Array.from(bots.values()).map(publicBot));
});

app.post('/api/bots', (req, res) => {
  const { sessionId, playerName, playerId, autoReady } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
  const bot = createBot({ sessionId, playerName, playerId, autoReady: autoReady !== false });
  res.status(201).json(publicBot(bot));
});

app.post('/api/bots/:botId/disconnect', (req, res) => {
  const bot = bots.get(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  clearBotTimers(bot);
  bot.socket?.disconnect();
  bot.connected = false;
  bot.status = 'disconnected';
  log('warn', `bot:${bot.playerName}`, 'Disconnected manually by SimLab');
  res.json(publicBot(bot));
});

app.post('/api/bots/:botId/reconnect', (req, res) => {
  const bot = bots.get(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  clearBotTimers(bot);
  bot.socket?.removeAllListeners();
  bot.socket?.disconnect();
  bot.connected = false;
  bot.status = 'connecting';
  attachBotSocket(bot);
  log('info', `bot:${bot.playerName}`, 'Reconnect requested manually by SimLab');
  res.json(publicBot(bot));
});

app.delete('/api/bots/:botId', (req, res) => {
  const bot = bots.get(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  clearBotTimers(bot);
  bot.socket?.removeAllListeners();
  bot.socket?.disconnect();
  bots.delete(bot.botId);
  log('info', `bot:${bot.playerName}`, 'Bot removed from SimLab');
  res.status(204).end();
});

app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await gameRequest('/admin/sessions/active');
    res.json(sessions);
  } catch (error) {
    log('error', 'session', 'Failed to list sessions', { message: error.message });
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const turnDurationSec = Number.parseInt(req.body?.turnDurationSec, 10) || 10;
    const session = await createGameSession(turnDurationSec);
    res.status(201).json(session);
  } catch (error) {
    log('error', 'session', 'Failed to create session', { message: error.message });
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/sessions/:sessionId/end', async (req, res) => {
  try {
    const result = await gameRequest(`/admin/sessions/${encodeURIComponent(req.params.sessionId)}/end`, {
      method: 'POST',
    });
    log('info', 'session', 'Session ended manually', { sessionId: req.params.sessionId });
    res.json(result);
  } catch (error) {
    log('error', 'session', 'Failed to end session', {
      sessionId: req.params.sessionId,
      message: error.message,
    });
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/scenarios/human-vs-bot', async (req, res) => {
  try {
    const turnDurationSec = Number.parseInt(req.body?.turnDurationSec, 10) || 10;
    const humanName = String(req.body?.humanName || 'Sim Player').trim() || 'Sim Player';
    const botName = String(req.body?.botName || 'Sim Bot').trim() || 'Sim Bot';
    const session = await createGameSession(turnDurationSec);
    const humanPlayerId = `human-${crypto.randomUUID()}`;
    const bot = createBot({ sessionId: session.sessionId, playerName: botName, autoReady: true });
    const playerUrl = buildPlayerUrl(session.joinUrl, humanPlayerId, humanName);

    log('info', 'scenario', 'Human vs Bot scenario created', {
      sessionId: session.sessionId,
      humanPlayerId,
      botPlayerId: bot.playerId,
    });

    res.status(201).json({
      session,
      player: { playerId: humanPlayerId, playerName: humanName, playerUrl },
      bot: publicBot(bot),
    });
  } catch (error) {
    log('error', 'scenario', 'Failed to create Human vs Bot scenario', { message: error.message });
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/scenarios/bot-vs-bot', async (req, res) => {
  try {
    const turnDurationSec = Number.parseInt(req.body?.turnDurationSec, 10) || 10;
    const session = await createGameSession(turnDurationSec);
    const botA = createBot({ sessionId: session.sessionId, playerName: req.body?.botAName || 'Bot A', autoReady: true });
    const botB = createBot({ sessionId: session.sessionId, playerName: req.body?.botBName || 'Bot B', autoReady: true });

    log('info', 'scenario', 'Bot vs Bot scenario created', {
      sessionId: session.sessionId,
      botA: botA.playerId,
      botB: botB.playerId,
    });

    res.status(201).json({ session, bots: [publicBot(botA), publicBot(botB)] });
  } catch (error) {
    log('error', 'scenario', 'Failed to create Bot vs Bot scenario', { message: error.message });
    res.status(502).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, gameServerUrl: GAME_SERVER_URL, tokenConfigured: Boolean(GAME_SERVER_TOKEN) });
});

app.listen(PORT, () => {
  log('info', 'simlab', `SimLab listening on http://localhost:${PORT}`);
  log('info', 'simlab', `Game server target: ${GAME_SERVER_URL}`);
  if (!GAME_SERVER_TOKEN) {
    log('warn', 'simlab', 'GAME_SERVER_TOKEN is empty; protected start/admin calls will fail until configured.');
  }
});
