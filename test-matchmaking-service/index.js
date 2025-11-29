const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const gameServerUrl = 'http://localhost:3000';

app.post('/create-session', async (req, res) => {
  try {
    const response = await axios.post(`${gameServerUrl}/sessions`, {
      players: req.body.players,
    });
    console.log('Session created:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('Error creating session:', error.message);
    res.status(500).send('Error creating session');
  }
});

app.post('/session-closed', (req, res) => {
  console.log('Session closed notification:', req.body);
  res.status(200).send();
});

app.listen(4000, () => {
  console.log('Test matchmaking service running on port 4000');
});
