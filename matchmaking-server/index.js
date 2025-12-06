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

if (!MATCHMAKING_AUTH_TOKEN || !MATCHMAKING_HMAC_SECRET) {
    console.error('FATAL ERROR: MATCHMAKING_AUTH_TOKEN and MATCHMAKING_HMAC_SECRET must be defined in .env file.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);

// --- Middleware ---

app.use(cors());

const saveRawBody = (req, res, buf, encoding) => {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
};
app.use(express.json({ verify: saveRawBody }));

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const verifyWebhookSignature = (req, res, next) => {
    // CORRECTED: The game-server documentation specifies 'X-Signature'.
    // Express headers are case-insensitive, so we check the lowercase version.
    const signature = req.headers['x-signature']; 

    if (!signature) {
        console.error('[Webhook Error] Signature header missing. Looked for \'x-signature\'.');
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
    console.log('[Webhook] Signature verified successfully.');
    next();
};

// --- Database Setup ---
const adapter = new JSONFile('db.json');
const db = new Low(adapter);

async function initializeDatabase() {
    await db.read();
    db.data = db.data || { queue: [], active_games: {}, ended_games: {} };
    await db.write();
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Main Application Logic ---
async function main() {
    await initializeDatabase();

    // --- HTTP ROUTES ---
    app.post('/session-closed', verifyWebhookSignature, async (req, res) => {
        const { session_id } = req.body;
        console.log(`[Webhook] Received session-closed event for session: ${session_id}`);

        if (!session_id) {
            return res.status(400).send('Bad Request: session_id is required.');
        }

        try {
            await db.read();
            const playerIdsInSession = Object.keys(db.data.active_games).filter(
                (playerId) => db.data.active_games[playerId].sessionId === session_id
            );

            if (playerIdsInSession.length === 0) {
                console.log(`[Webhook] No active players for session ${session_id}. It may have been cleared already.`);
                return res.status(200).send('Session already cleared or unknown.');
            }

            console.log(`[State] Clearing active session ${session_id} for players: ${playerIdsInSession.join(', ')}`);
            for (const playerId of playerIdsInSession) {
                delete db.data.active_games[playerId];
            }
            db.data.ended_games[session_id] = { ended_at: new Date().toISOString() };
            await db.write();

            console.log(`[State] Session ${session_id} successfully closed.`);
            res.status(200).send('Session successfully closed.');
        } catch (error) {
            console.error(`[FATAL] Error processing /session-closed for session ${session_id}:`, error);
            res.status(500).send('Internal Server Error.');
        }
    });

    // --- SOCKET.IO LOGIC ---
    io.on('connection', (socket) => {
        // ... (socket logic remains the same)
    });

    server.listen(PORT, () => {
        console.log(`Matchmaking server listening on http://localhost:${PORT}`);
    });
}

main();