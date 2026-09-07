const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
require('dotenv').config();
const { validateEnv } = require('./src/config/validateEnv');

// --- Validate Environment Variables before doing anything else ---
validateEnv();

const sessionManager = require('./src/game/session'); // Import the session manager
const httpRoutes = require('./src/http/routes');
const adminDlqRoutes = require('./src/http/admin_dlq_routes');
const adminServerRoutes = require('./src/http/admin_server_routes'); // Import the new server admin routes
const { initializeSocket } = require('./src/game/socket_handler');
const sessionLogger = require('./src/logging/session_logger');
const webhookDispatcher = require('./src/webhooks/dispatcher');

// --- Initialize services ---
sessionLogger.init();
webhookDispatcher.init();
sessionManager.init(); // Start the stale session cleanup timer

const app = express();
// Cloudflare Tunnel terminates HTTPS before forwarding to this HTTP process.
// Trust the first proxy hop so req.protocol and generated public URLs remain HTTPS.
app.set('trust proxy', 1);
const server = http.createServer(app);

// --- Socket origin policy ---
// Production clients are served by this same Express process. Accept the
// current request host automatically and keep CLIENT_ORIGIN/CLIENT_ORIGINS as
// optional development overrides.
const configuredOrigins = [
  ...(process.env.CLIENT_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean),
  ...(process.env.CLIENT_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
];
const allowedOrigins = [...new Set(configuredOrigins)];
const isLoopbackOrigin = (origin) => {
  try {
    const parsed = new URL(origin);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch (error) {
    return false;
  }
};
const isAllowedSocketRequest = (req) => {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin) || isLoopbackOrigin(origin)) return true;
  try {
    const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0]
      .trim();
    return new URL(origin).host === requestHost;
  } catch (error) {
    return false;
  }
};

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: false,
  },
  allowRequest: (req, callback) => callback(null, isAllowedSocketRequest(req)),
});

const PORT = process.env.PORT || 3000;

// Initialize Socket.IO connection handling
initializeSocket(io);

app.use(express.json());

// Mount routers
app.use(httpRoutes);
app.use('/admin', adminDlqRoutes);
app.use('/admin', adminServerRoutes); // Mount the new server admin routes

const clientDir = path.join(__dirname, 'public');

// The join URL returned by /start is also the actual playable game page.
app.get('/session/:sessionId/join', (req, res) => {
  const session = sessionManager.getSession(req.params.sessionId);
  if (!session || session.status === 'ended') {
    return res.status(404).send('Session not found or ended.');
  }
  // WebViews are especially prone to holding a stale HTML shell after an app
  // update. Always revalidate the playable document and browser code.
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.sendFile('index.html', { root: clientDir });
});

// Serve the bundled game client (JS/CSS/assets) from the same origin as the API/socket server.
// Keep images/audio cacheable, but never allow old JS/HTML to survive a deploy.
app.use(express.static(clientDir, {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

app.get('/', (req, res) => {
  res.send('Game server is running. Open a session join URL to play.');
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('Client: served from the same server origin.');
  console.log(`Additional Socket.IO origins: ${allowedOrigins.length ? allowedOrigins.join(', ') : '(none)'}`);
});
