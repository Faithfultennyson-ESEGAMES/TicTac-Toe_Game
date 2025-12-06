
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { JSONFile, Low } = require('lowdb');

// --- Configuration & Initialization ---

const PORT = process.env.PORT || 3000;
const MATCHMAKING_AUTH_TOKEN = process.env.MATCHMAKING_AUTH_TOKEN;
const MATCHMAKING_HMAC_SECRET = process.env.MATCHMAKING_HMAC_SECRET;
const GAME_SERVER_URL = process.env.GAME_SERVER_URL;
const DB_ENTRY_TTL_MS = parseInt(process.env.DB_ENTRY_TTL_MS, 10);

if (!MATCHMAKING_AUTH_TOKEN || !MATCHMAKING_HMAC_SECRET) {
    console.error('FATAL ERROR: MATCHMAKING_AUTH_TOKEN and MATCHMAKING_HMAC_SECRET must be defined in .env file.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // For simplicity; restrict in production
        methods: ["GET", "POST"]
    }
});

// --- Database Setup ---

// CORRECTED: Path is now relative to the execution directory
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

// --- Middleware ---

const rawBodySaver = (req, res, buf, encoding) => {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
};

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

app.use(bodyParser.json({ verify: rawBodySaver }));


// --- Main Application Logic ---

async function main() {
    await initializeDatabase();
    
    // --- HTTP Routes ---
    
    app.post('/session-closed', verifyWebhookSignature, async (req, res) => {
        const { session_id, players } = req.body;
        console.log(`[Webhook] Received session.ended for session: ${session_id}`);

        await db.read();
        
        if (players && Array.isArray(players)) {
            players.forEach(player => {
                if (db.data.active_games[player.playerId]) {
                    delete db.data.active_games[player.playerId];
                    console.log(`[State] Removed active game lock for player: ${player.playerId}`);
                }
            });
        }
        
        db.data.ended_games[session_id] = Date.now();
        await db.write();

        res.status(200).send({ message: 'Acknowledged' });
    });

    // --- Socket.IO Logic ---
    
    io.on('connection', (socket) => {
        console.log(`[Socket] Client connected: ${socket.id}`);

        socket.on('request-match', async (data) => {
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
                
                try {
                    const response = await fetch(`${GAME_SERVER_URL}/start`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${MATCHMAKING_AUTH_TOKEN}`
                        }
                    });

                    if (!response.ok) {
                        throw new Error(`Game server returned ${response.status}`);
                    }
                    
                    // VERIFY THE RESPONSE FROM THE GAME SERVER
                    const signature = response.headers.get('x-matchmaking-signature');
                    const bodyText = await response.text();
                    const expectedSignature = crypto.createHmac('sha256', MATCHMAKING_HMAC_SECRET).update(bodyText).digest('hex');

                    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
                        throw new Error('Invalid response signature from game server');
                    }

                    const { session_id, join_url } = JSON.parse(bodyText);
                    console.log(`[Game Server] Successfully created and verified session ${session_id}`);

                    await db.read();
                    db.data.active_games[player1.playerId] = { sessionId: session_id, join_url };
                    db.data.active_games[player2.playerId] = { sessionId: session_id, join_url };
                    await db.write();

                    io.to(player1.socketId).emit('match-found', { session_id, join_url });
                    io.to(player2.socketId).emit('match-found', { session_id, join_url });

                } catch (error) {
                    console.error('[Error] Failed to create or verify game session:', error.message);
                    db.data.queue.unshift(player2, player1);
                    await db.write();
                    io.to(player1.socketId).emit('match-error', { message: 'Failed to create game. Please try again.' });
                    io.to(player2.socketId).emit('match-error', { message: 'Failed to create game. Please try again.' });
                }
            }
        });

        socket.on('disconnect', async () => {
            console.log(`[Socket] Client disconnected: ${socket.id}`);
            await db.read();
            const index = db.data.queue.findIndex(p => p.socketId === socket.id);
            if (index !== -1) {
                const { playerId } = db.data.queue.splice(index, 1)[0];
                console.log(`[State] Player ${playerId} removed from queue due to disconnect.`);
                await db.write();
            }
        });
    });

    // --- Periodic Cleanup ---
    setInterval(async () => {
        await db.read();
        const now = Date.now();
        let changed = false;
        for (const sessionId in db.data.ended_games) {
            if (now - db.data.ended_games[sessionId] > DB_ENTRY_TTL_MS) {
                delete db.data.ended_games[sessionId];
                changed = true;
                console.log(`[Cleanup] Removed old ended_game entry: ${sessionId}`);
            }
        }
        if (changed) {
            await db.write();
        }
    }, DB_ENTRY_TTL_MS / 4);

    server.listen(PORT, () => {
        console.log(`Matchmaking server listening on http://localhost:${PORT}`);
    });
}

main();
