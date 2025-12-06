require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { JSONFile, Low } = require('lowdb');
const cors = require('cors');

// --- Configuration & Initialization ---

const PORT = process.env.PORT || 3330;
const MATCHMAKING_AUTH_TOKEN = process.env.MATCHMAKING_AUTH_TOKEN;
const MATCHMAKING_HMAC_SECRET = process.env.MATCHMAKING_HMAC_SECRET;
const GAME_SERVER_URL = process.env.GAME_SERVER_URL;
const DB_ENTRY_TTL_MS = parseInt(process.env.DB_ENTRY_TTL_MS, 10) || 3600000;
const MAX_SESSION_CREATION_ATTEMPTS = parseInt(process.env.MAX_SESSION_CREATION_ATTEMPTS, 10) || 3;
const SESSION_CREATION_RETRY_DELAY_MS = parseInt(process.env.SESSION_CREATION_RETRY_DELAY_MS, 10) || 1500;

if (!MATCHMAKING_AUTH_TOKEN || !MATCHMAKING_HMAC_SECRET) {
    console.error('FATAL ERROR: MATCHMAKING_AUTH_TOKEN and MATCHMAKING_HMAC_SECRET must be defined in .env file.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);

// --- Middleware ---

app.use(cors());

// Middleware to save raw body for signature verification
const saveRawBody = (req, res, buf, encoding) => {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
};
// Use JSON parser with the raw body saver. IMPORTANT: This must come before the routes that need it.
app.use(express.json({ verify: saveRawBody }));

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const verifyWebhookSignature = (req, res, next) => {
    const signature = req.headers['x-matchmaking-signature'];
    if (!signature) {
        console.error('[Webhook Error] Signature header missing.');
        return res.status(401).send('Signature header missing.');
    }
    
    if (!req.rawBody) {
        console.error('[Webhook Error] Raw body not available for signature verification.');
        return res.status(500).send('Internal Server Error: Raw body not saved.');
    }

    const expectedSignature = crypto.createHmac('sha256', MATCHMAKING_HMAC_SECRET).update(req.rawBody).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        console.error('[Webhook Error] Invalid signature.');
        return res.status(403).send('Invalid signature.');
    }
    next();
};


// --- Database Setup ---

const adapter = new JSONFile('db.json');
const db = new Low(adapter);

async function initializeDatabase() {
    await db.read();
    db.data = db.data || {
        queue: [],
        active_games: {},
        ended_games: {}
    };
    await db.write();
}

// --- Helper Functions ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Main Application Logic ---

async function main() {
    await initializeDatabase();

    // --- HTTP ROUTES ---
    app.post('/session-closed', verifyWebhookSignature, async (req, res) => {
        const { session_id } = req.body;
        console.log(`[Webhook] Received session-closed event for session: ${session_id}`);

        if (!session_id) {
            console.warn('[Webhook] Received session-closed event with no session_id.');
            return res.status(400).send('Bad Request: session_id is required.');
        }

        try {
            await db.read();

            const playerIdsInSession = Object.keys(db.data.active_games).filter(
                (playerId) => db.data.active_games[playerId].sessionId === session_id
            );

            if (playerIdsInSession.length === 0) {
                console.log(`[Webhook] No active players found for session ${session_id}. It might have already been cleared.`);
                return res.status(200).send('Session already cleared or unknown.');
            }

            console.log(`[State] Clearing active session ${session_id} for players: ${playerIdsInSession.join(', ')}`);

            for (const playerId of playerIdsInSession) {
                delete db.data.active_games[playerId];
            }

            db.data.ended_games[session_id] = { ended_at: new Date().toISOString() };

            await db.write();

            console.log(`[State] Session ${session_id} successfully closed and moved to ended_games.`);
            res.status(200).send('Session successfully closed.');
        } catch (error) {
            console.error(`[FATAL] Error processing /session-closed for session ${session_id}:`, error);
            res.status(500).send('Internal Server Error.');
        }
    });


    // --- SOCKET.IO LOGIC ---
    io.on('connection', (socket) => {
        console.log(`[Socket] Client connected: ${socket.id}`);

        socket.on('request-match', async (data) => {
            try {
                const { playerId, playerName } = data;
                if (!playerId) {
                    return socket.emit('match-error', { message: 'PlayerId is required.' });
                }
                console.log(`[Socket] Match requested by PlayerID: ${playerId}`);

                await db.read();

                if (db.data.active_games[playerId]) {
                    const { join_url } = db.data.active_games[playerId];
                    console.log(`[State] Player ${playerId} is already in a game. Resending join_url.`);
                    return socket.emit('match-found', { join_url });
                }

                if (!db.data.queue.some(p => p.playerId === playerId)) {
                    db.data.queue.push({ playerId, playerName, socketId: socket.id });
                    await db.write();
                    console.log(`[State] Player ${playerId} added to queue. Queue size: ${db.data.queue.length}`);
                }

                if (db.data.queue.length >= 2) {
                    const [player1, player2] = db.data.queue.splice(0, 2);
                    await db.write();
                    console.log(`[Match] Found a match between ${player1.playerId} and ${player2.playerId}. Queue updated.`);

                    // Session creation logic...
                }
            } catch (err) {
                console.error('[FATAL] Unhandled error in request-match handler:', err);
                socket.emit('match-error', { message: 'An unexpected server error occurred.' });
            }
        });

        socket.on('disconnect', async () => {
            console.log(`[Socket] Client disconnected: ${socket.id}`);
            try {
                await db.read();
                const index = db.data.queue.findIndex(p => p.socketId === socket.id);
                if (index !== -1) {
                    const { playerId } = db.data.queue.splice(index, 1)[0];
                    console.log(`[State] Player ${playerId} removed from queue due to disconnect.`);
                    await db.write();
                }
            } catch (err) {
                console.error('[FATAL] Unhandled error in disconnect handler:', err);
            }
        });
    });

    server.listen(PORT, () => {
        console.log(`Matchmaking server listening on http://localhost:${PORT}`);
    });
}

main();
