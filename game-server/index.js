const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const httpRoutes = require('./src/http/routes');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(httpRoutes);

app.get('/', (req, res) => {
  res.send('Game server is running.');
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
