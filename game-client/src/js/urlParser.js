const parseQueryParams = () => {
  const params = new URLSearchParams(window.location.search);

  const playerId = params.get('playerId') || params.get('userId') || '';
  const name = params.get('name') || 'Guest';
  const stake = Number(params.get('stake') || 0);
  const sessionId = params.get('sessionId') || null;
  const token = params.get('token') || null;

  return {
    playerId,
    name,
    stake,
    sessionId,
    token,
    raw: params,
  };
};

const buildRejoinPayload = (sessionData) => ({
  sessionId: sessionData.sessionId,
  playerId: sessionData.playerId,
});

export { parseQueryParams, buildRejoinPayload };
