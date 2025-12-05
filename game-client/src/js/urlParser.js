const parseQueryParams = () => {
  const params = new URLSearchParams(window.location.search);

  const join_url = params.get('join_url');
  const playerId = params.get('player_id');
  const playerName = params.get('player_name');

  let sessionId = null;
  if (join_url) {
    try {
      const path = new URL(join_url).pathname; // Gets '/session/sess_123/join'
      const match = path.match(/\/session\/(.*?)\/join/);
      if (match && match[1]) {
        sessionId = match[1];
      }
    } catch (e) {
      console.error(`[urlParser] Invalid join_url: ${join_url}`);
    }
  }

  return {
    join_url,
    sessionId,
    playerId,
    playerName,
    raw: params,
  };
};

const buildRejoinPayload = (sessionData) => ({
  sessionId: sessionData.sessionId,
  playerId: sessionData.playerId,
});

export { parseQueryParams, buildRejoinPayload };
