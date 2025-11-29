const gameConfig = require('../config/gameConfig');

const totalCells = gameConfig.game.boardSize ** 2;

const getPlayerSymbolById = (session, playerId) => {
  if (!session) {
    return null;
  }
  if (session.players.X.id === playerId) {
    return 'X';
  }
  if (session.players.O.id === playerId) {
    return 'O';
  }
  return null;
};

const isValidPosition = (position) => Number.isInteger(position) && position >= 0 && position < totalCells;

const isCellEmpty = (board, position) => board[position] === null;

const checkWin = (board, symbol) => {
  const { winConditions } = gameConfig.game;
  for (let index = 0; index < winConditions.length; index += 1) {
    const combo = winConditions[index];
    if (combo.every((cell) => board[cell] === symbol)) {
      return combo;
    }
  }
  return null;
};

const checkDraw = (board) => board.every((cell) => cell !== null);

const validateMove = (session, playerId, position) => {
  if (!session) {
    return { valid: false, reason: 'session_not_found' };
  }

  const playerSymbol = getPlayerSymbolById(session, playerId);
  if (!playerSymbol) {
    return { valid: false, reason: 'player_not_in_session' };
  }

  if (session.status !== 'active') {
    return { valid: false, reason: 'session_not_active' };
  }

  if (session.currentTurn !== playerSymbol) {
    return { valid: false, reason: 'not_player_turn' };
  }

  if (!isValidPosition(position)) {
    return { valid: false, reason: 'invalid_position' };
  }

  if (!isCellEmpty(session.board, position)) {
    return { valid: false, reason: 'cell_occupied' };
  }

  return { valid: true, playerSymbol };
};

module.exports = {
  getPlayerSymbolById,
  isValidPosition,
  isCellEmpty,
  checkWin,
  checkDraw,
  validateMove,
};
