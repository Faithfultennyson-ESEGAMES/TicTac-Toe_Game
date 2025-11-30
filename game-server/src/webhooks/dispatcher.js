const http = require('http');
const https = require('https');
const crypto = require('crypto');

const WEBHOOK_ENDPOINTS = process.env.WEBHOOK_ENDPOINTS ? process.env.WEBHOOK_ENDPOINTS.split(',') : [];
const HMAC_SECRET = process.env.HMAC_SECRET;

async function dispatchEvent(eventType, payload, sessionId) {
    if (!WEBHOOK_ENDPOINTS.length) {
        return; 
    }

    if (!HMAC_SECRET) {
        console.warn('HMAC_SECRET is not configured. Webhooks will not be signed.');
    }

    const eventId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const envelope = {
        event_id: eventId,
        event_type: eventType,
        session_id: sessionId,
        timestamp,
        payload: payload,
    };

    const rawBody = JSON.stringify(envelope);

    const headers = {
        'Content-Type': 'application/json',
        'X-Event-ID': eventId,
        'X-Timestamp': timestamp,
    };

    if (HMAC_SECRET) {
        const signature = crypto.createHmac('sha256', HMAC_SECRET)
                                .update(`${timestamp}.${rawBody}`)
                                .digest('hex');
        headers['X-Signature'] = signature;
    }

    for (const endpoint of WEBHOOK_ENDPOINTS) {
        try {
            const url = new URL(endpoint);
            const transport = url.protocol === 'https:' ? https : http;

            const options = {
                method: 'POST',
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                headers: headers
            };

            const req = transport.request(options, (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    console.error(`[Webhook Dispatch] Endpoint ${endpoint} responded with status: ${res.statusCode}`);
                }
            });

            req.on('error', (e) => {
                console.error(`[Webhook Dispatch] Request to ${endpoint} failed:`, e);
            });

            req.write(rawBody);
            req.end();

        } catch (error) {
            console.error(`[Webhook Dispatch] Invalid webhook endpoint URL: ${endpoint}`, error);
        }
    }
}

module.exports = { dispatchEvent };
