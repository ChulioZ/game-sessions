/* Spieleabend – buy-next: local "play these again" recommendations (issue #101,
   Layer A). Pure and dependency-free, so it works both as a shared-scope
   frontend script (browser global) and as a CommonJS module the test suite can
   require. Load order: see index.html. */

'use strict';

// Local, on-demand mirror of retireRecommendations: active games the group
// rates highly. Ranked so the most-loved, least-played surface first, turning
// "what should we get out next?" into a rediscovery nudge. Gated behind a
// minimum vote count (like retireRecommendations) so nothing fires on thin data.
// `statsByGame` maps gameId -> gameStats(round, gameId). Returns
// [{ game, avg, sessions }, …], most worth revisiting first.
function playNextRecommendations(activeGames, statsByGame, minVotes) {
  const HIGH_AVG = 4.0; // "really liked" on the 1–5 scale
  const recs = [];
  activeGames.forEach((g) => {
    const st = statsByGame[g.id];
    if (!st || st.votesCast < minVotes || st.avg === null || st.avg < HIGH_AVG) return;
    recs.push({ game: g, avg: st.avg, sessions: st.sessions });
  });
  // Least-played first (rediscovery); break ties by the higher average.
  recs.sort((a, b) => a.sessions - b.sessions || b.avg - a.avg);
  return recs;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { playNextRecommendations };
}
