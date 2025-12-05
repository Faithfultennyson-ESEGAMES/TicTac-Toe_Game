
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = 4000;

// --- In-Memory Store ---
const webhookLogs = new Map();

// --- Middleware ---
app.use(express.raw({ type: 'application/json', limit: '5mb' })); // For HMAC
app.use(express.json({ limit: '5mb' })); // For other routes

// --- Helper Functions ---
function verifySignature(rawBody, signatureHeader) {
    const secret = process.env.HMAC_SECRET;
    if (!secret || !signatureHeader) return false;
    const expectedPrefix = 'sha256=';
    if (!signatureHeader.startsWith(expectedPrefix)) return false;

    const computedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const expected = `${expectedPrefix}${computedHex}`;

    try {
        return crypto.timingSafeEqual(Buffer.from(signatureHeader, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch {
        return false;
    }
}

// --- Main Application Routes ---

// 1. Endpoint to RECEIVE webhooks from the game-server
app.post('/webhook', (req, res) => {
    const eventId = req.header('X-Event-Id') || `evt_${Date.now()}`;
    const signature = req.header('X-Signature');
    // req.body is a Buffer here because of express.raw()
    const isValid = verifySignature(req.body, signature);

    let parsedBody = {};
    try {
        parsedBody = JSON.parse(req.body.toString('utf8'));
    } catch (e) { /* Ignore parsing errors */ }

    const logEntry = {
        id: eventId,
        receivedAt: new Date().toISOString(),
        eventType: req.header('X-Event-Type'),
        sessionId: parsedBody.session_id || 'N/A',
        signature,
        isValid,
        payload: parsedBody,
    };

    webhookLogs.set(logEntry.id, logEntry);
    console.log(`[INFO] Webhook: ${logEntry.eventType}, Session: ${logEntry.sessionId}, Valid: ${isValid}`);

    setTimeout(() => {
        webhookLogs.delete(logEntry.id);
        console.log(`[INFO] Auto-deleted log: ${logEntry.id}`);
    }, 1800000);

    res.status(200).json({ ok: true });
});

// 2. Endpoint for the FRONTEND to FETCH webhook logs
app.post('/api/webhooks', (req, res) => {
    if (req.body.password !== process.env.VIEWER_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json(Array.from(webhookLogs.values()));
});

// 3. SECURE PROXY for sending admin commands to the game-server
app.post('/api/admin-action', async (req, res) => {
    // First-level auth: Does the user have the UI password?
    if (req.body.viewerPassword !== process.env.VIEWER_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { action, params } = req.body;
    const { GAME_SERVER_URL, DLQ_PASSWORD } = process.env;

    if (!GAME_SERVER_URL || !DLQ_PASSWORD) {
        return res.status(500).json({ error: 'Backend is missing game server configuration.' });
    }

    let url, method, data;

    // Construct the request based on the desired action
    switch (action) {
        case 'end_session':
            url = `${GAME_SERVER_URL}/admin/sessions/${params.sessionId}/end`;
            method = 'POST';
            break;
        case 'list_dlq':
            url = `${GAME_SERVER_URL}/admin/dlq`;
            method = 'GET';
            break;
        case 'get_dlq_item':
            url = `${GAME_SERVER_URL}/admin/dlq/${params.dlqId}`;
            method = 'GET';
            break;
        case 'resend_dlq_item':
            url = `${GAME_SERVER_URL}/admin/dlq/${params.dlqId}/resend`;
            method = 'POST';
            break;
        case 'delete_dlq':
            url = `${GAME_SERVER_URL}/admin/dlq`;
            method = 'DELETE';
            data = { password: DLQ_PASSWORD }; // Special requirement for this endpoint
            break;
        default:
            return res.status(400).json({ error: 'Invalid admin action' });
    }

    try {
        const response = await axios({
            method,
            url,
            headers: { 'Authorization': `Bearer ${DLQ_PASSWORD}` },
            data
        });
        res.status(response.status).json(response.data);
    } catch (error) {
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ error: 'Network error or game server is down.' });
        }
    }
});

// 4. Serve the Admin Control Panel UI
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.listen(PORT, () => {
    console.log(`Admin Control Panel listening on http://localhost:${PORT}`);
    if (!process.env.HMAC_SECRET) console.warn('[WARN] HMAC_SECRET is not set.');
    if (!process.env.VIEWER_PASSWORD) console.warn('[WARN] VIEWER_PASSWORD is not set.');
    if (!process.env.GAME_SERVER_URL) console.warn('[WARN] GAME_SERVER_URL is not set.');
    if (!process.env.DLQ_PASSWORD) console.warn('[WARN] DLQ_PASSWORD is not set.');
});
