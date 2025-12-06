require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
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
const SESSION_CREATION_RETRY_DELAY_MS = parseInt(process.env.SESSION_CREATION_RETRY_DELAY_MS, 10) || 1000;

if (!MATCHMAKING_AUTH_TOKEN || !MATCHMAKING_HMAC_SECRET) {
    console.error('FATAL ERROR: MATCHMAKING_AUTH_TOKEN and MATCHMAKING_HMAC_SECRET must be defined in .env file.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);

// --- Middleware ---

app.use(cors());

const rawBodySaver = (req, res, buf, encoding) => {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
};
app.use(bodyParser.json({ verify: rawBodySaver }));

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const verifyWebhookSignature = (req, res, next) => {
    const signature = req.headers['x-matchmaking-signature'];
    if (!signature) {
        return res.status(401).send('Signature header missing.');
    }
    const expectedSignature = crypto.createHmac('sha256', MATCHMAKING_HMAC_SECRET).update(req.rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
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
    
    // --- HTTP Routes ---
    app.post('/session-closed', verifyWebhookSignature, async (req, res) => {
        // ... (this logic remains the same)
    });

    // --- Socket.IO Logic ---
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
                    console.log(`[Match] Found a match between ${player1.playerId} and ${player2.playerId}`);

                    let sessionCreated = false;
                    for (let attempt = 1; attempt <= MAX_SESSION_CREATION_ATTEMPTS; attempt++) {
                        try {
                            console.log(`[Game Server] Attempt ${attempt} to create session for ${player1.playerId} and ${player2.playerId}`);
                            const response = await fetch(`${GAME_SERVER_URL}/start`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${MATCHMAKING_AUTH_TOKEN}`
                                }
                            });

                            if (!response.ok) {
                                throw new Error(`Game server returned status ${response.status}`);
                            }

                            const signatureHeader = response.headers.get('x-matchmaking-signature');
                            if (!signatureHeader) {
                                throw new Error('Response from game server is missing signature header');
                            }

                            // CORRECTED: Use arrayBuffer() for raw body and verify with prefix
                            const bodyBuffer = await response.arrayBuffer();
                            const computedHex = crypto.createHmac('sha256', MATCHMAKING_HMAC_SECRET).update(Buffer.from(bodyBuffer)).digest('hex');
                            const expectedSignature = `sha256=${computedHex}`;

                            if (!crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSignature))) {
                                throw new Error('Invalid response signature from game server');
                            }
                            
                            // Only parse JSON after verification
                            const { session_id, join_url } = JSON.parse(Buffer.from(bodyBuffer).toString('utf8'));
                            console.log(`[Game Server] Successfully created and verified session ${session_id}`);

                            await db.read();
                            db.data.active_games[player1.playerId] = { sessionId: session_id, join_url };
                            db.data.active_games[player2.playerId] = { sessionId: session_id, join_url };
                            await db.write();

                            io.to(player1.socketId).emit('match-found', { session_id, join_url });
                            io.to(player2.socketId).emit('match-found', { session_id, join_url });

                            sessionCreated = true;
                            break; // Success, exit the retry loop

                        } catch (error) {
                            console.error(`[Error] Attempt ${attempt} failed:`, error.message);
                            if (attempt < MAX_SESSION_CREATION_ATTEMPTS) {
                                console.log(`[Retry] Waiting ${SESSION_CREATION_RETRY_DELAY_MS}ms before next attempt.`);
                                await delay(SESSION_CREATION_RETRY_DELAY_MS);
                            } else {
                                console.error('[Fatal] All attempts to create a game session failed.');
                                // Return players to the front of the queue if all attempts fail
                                await db.read();
                                db.data.queue.unshift(player1, player2);
                                await db.write();

                                // Notify clients of the final failure
                                io.to(player1.socketId).emit('match-error', { message: 'Could not create game session after multiple attempts.' });
                                io.to(player2.socketId).emit('match-error', { message: 'Could not create game session after multiple attempts.' });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('[FATAL] Unhandled error in request-match handler:', err);
                socket.emit('match-error', { message: 'An unexpected server error occurred.' });
            }
        });

        socket.on('disconnect', async () => {
           // ... (this logic remains the same)
        });
    });

    // --- Periodic Cleanup ---
    setInterval(async () => {
        // ... (this logic remains the same)
    }, DB_ENTRY_TTL_MS / 4);

    server.listen(PORT, () => {
        console.log(`Matchmaking server listening on http://localhost:${PORT}`);
    });
}

main();
