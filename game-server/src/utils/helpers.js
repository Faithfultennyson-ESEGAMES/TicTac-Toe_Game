const MS_IN_SECOND = 1000;

const toNumberOr = (value, fallback) => {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const normalizePlayer = (player) => ({
  id: String(player.id ?? ''),
  name: player.name ? String(player.name).trim() : 'Anonymous',
  stake: toNumberOr(player.stake, 0),
  metadata: player.metadata || {},
});

const calculateStakes = (playerXStake, playerOStake, houseFeeRate) => {
  const totalStake = Math.max(0, playerXStake) + Math.max(0, playerOStake);
  const houseCut = Math.round(totalStake * houseFeeRate);
  const winnerPayout = totalStake - houseCut;

  return {
    totalStake,
    houseCut,
    winnerPayout: Math.max(0, winnerPayout),
    currency: 'credits',
  };
};

const formatDuration = (seconds) => {
  const value = Math.max(0, Math.floor(seconds));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }

  if (m > 0) {
    return `${m}m ${s}s`;
  }

  return `${s}s`;
};

const secondsToMilliseconds = (seconds) => Math.max(0, seconds) * MS_IN_SECOND;

const nowTimestamp = () => new Date().toISOString();

const clone = (value) => JSON.parse(JSON.stringify(value));

module.exports = {
  normalizePlayer,
  calculateStakes,
  formatDuration,
  secondsToMilliseconds,
  nowTimestamp,
  clone,
};
