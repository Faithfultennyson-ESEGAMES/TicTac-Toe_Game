const express = require('express');
const { createSession } = require('../game/session');
const { dispatchEvent } = require('../webhooks/dispatcher');

const router = express.Router();

router.post('/start', async (req, res) => {
  let { turn_duration_sec } = req.body;

  if (turn_duration_sec !== undefined) {
    turn_duration_sec = parseInt(turn_duration_sec, 10);
    if (isNaN(turn_duration_sec) || turn_duration_sec <= 0) {
      return res.status(400).json({ error: 'Invalid turn_duration_sec. Must be a positive integer.' });
    }
  }

  const session = createSession(turn_duration_sec);

  // Dispatch the session.started webhook
  await dispatchEvent('session.started', session);

  const join_url = `${req.protocol}://${req.get('host')}/session/${session.sessionId}/join`;

  res.status(201).json({
    session_id: session.sessionId,
    join_url: join_url,
  });
});

module.exports = router;
