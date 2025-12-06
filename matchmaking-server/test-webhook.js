
require('dotenv').config({ path: './.env' }); // Make sure it loads the correct .env
const crypto = require('crypto');
const fetch = require('node-fetch'); // You might need to run: npm install node-fetch

// --- CONFIGURATION ---
const NGROK_URL = 'https://94c4d018290c.ngrok-free.app'; // Your ngrok URL
const ENDPOINT = '/session-closed';
const HMAC_SECRET = process.env.MATCHMAKING_HMAC_SECRET;

// --- DATA TO SEND ---
const payload = {
    session_id: "b2d7bd33-b428-4753-b812-316954720c77",
    // You can add other fields here if the game-server sends them,
    // but they won't affect the matchmaking server's logic.
    // example: final_state: { ... }
};

// --- SCRIPT LOGIC ---

async function sendSignedWebhook() {
    if (!HMAC_SECRET) {
        console.error('FATAL: Could not find MATCHMAKING_HMAC_SECRET in your .env file.');
        return;
    }

    const url = `${NGROK_URL}${ENDPOINT}`;
    const body = JSON.stringify(payload);

    // 1. Calculate the signature
    const signature = crypto.createHmac('sha256', HMAC_SECRET)
                            .update(body)
                            .digest('hex');
    
    console.log(`Sending webhook to: ${url}`);
    console.log(`Payload body: ${body}`);
    console.log(`Calculated Signature: ${signature}`);

    try {
        // 2. Send the request
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-matchmaking-signature': signature
            },
            body: body
        });

        // 3. Report the result
        const responseBody = await response.text();
        console.log('\n--- RESPONSE ---');
        console.log(`Status: ${response.status} ${response.statusText}`);
        console.log(`Body: ${responseBody}`);

    } catch (error) {
        console.error('\n--- ERROR ---');
        console.error('Failed to send webhook:', error.message);
    }
}

sendSignedWebhook();
