import debug from './debug.js';

const parseQueryParams = () => {
  const params = new URLSearchParams(window.location.search);

  // Support both camelCase and snake_case for flexibility.
  const joinUrl = params.get('joinUrl') || params.get('join_url');
  const playerId = params.get('playerId') || params.get('player_id');
  const playerName = params.get('playerName') || params.get('player_name');

  let sessionId = null;
  if (joinUrl) {
    try {
      const path = new URL(joinUrl).pathname;
      // Extracts the session ID (any characters except '/') from /session/some-id/...
      const match = path.match(/\/session\/([^\/]+)/);
      if (match && match[1]) {
        sessionId = match[1];
      }
    } catch (e) {
      debug.error('[urlParser] Invalid joinUrl:', joinUrl, e);
    }
  }

  const parsed = {
    joinUrl,
    sessionId,
    playerId: playerId,
    playerName: playerName,
    raw: params,
  };

  debug.log('[urlParser] Parsed query params:', parsed);
  return parsed;
};

// This function is not strictly needed for the new flow but is kept for potential future use.
const buildRejoinPayload = (sessionData) => ({
  sessionId: sessionData.sessionId,
  playerId: sessionData.playerId,
});

export { parseQueryParams, buildRejoinPayload };
