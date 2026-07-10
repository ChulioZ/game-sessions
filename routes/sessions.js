'use strict';

/* Routes for game sessions: start (random pick), save results, choose game,
   finish/winners, cancel, delete.
   Mounted under /api/rounds/:rid/sessions (mergeParams for rid). */

const express = require('express');
const { saveData, id, findRound } = require('../lib/store');

const router = express.Router({ mergeParams: true });

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const findSession = (round, sid) => round.sessions.find((s) => s.id === sid);

// Start a new session: random pick of games by filter.
router.post('/', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  const filter = ['all', 'digital', 'analog'].includes(req.body.filter) ? req.body.filter : 'all';
  // Duration filter: array of 'short'/'medium'/'long'. Missing, empty or the
  // full set means "no duration filter" (games without a duration included).
  const DURATIONS = ['short', 'medium', 'long'];
  let durations = Array.isArray(req.body.durations)
    ? req.body.durations.filter((d) => DURATIONS.includes(d))
    : [];
  if (durations.length === 0 || durations.length === DURATIONS.length) durations = null;
  let count = parseInt(req.body.count, 10);
  if (!Number.isFinite(count) || count < 1) count = 1;

  // Members joining this session. Missing/empty means everyone (back-compat).
  // The joining count filters games by their player range below.
  const memberById = new Set(round.members.map((m) => m.id));
  let memberIds = Array.isArray(req.body.memberIds)
    ? req.body.memberIds.map(String).filter((mid) => memberById.has(mid))
    : [];
  if (memberIds.length === 0) memberIds = round.members.map((m) => m.id);
  if (memberIds.length === 0)
    return res.status(400).json({ error: 'At least one member must join' });
  const playerCount = memberIds.length;
  const members = round.members.filter((m) => memberIds.includes(m.id));

  const pool = round.games.filter(
    (g) =>
      !g.retired &&
      (filter === 'all' || g.type === filter) &&
      (!durations || durations.includes(g.duration)) &&
      (typeof g.minPlayers !== 'number' || playerCount >= g.minPlayers) &&
      (typeof g.maxPlayers !== 'number' || playerCount <= g.maxPlayers)
  );
  if (pool.length === 0)
    return res.status(400).json({ error: 'No matching games in this round' });

  const picked = shuffle(pool.slice()).slice(0, Math.min(count, pool.length));

  const session = {
    id: id(),
    createdAt: new Date().toISOString(),
    filter,
    durations, // null = all durations
    requestedCount: count,
    memberIds, // members who joined this session
    gameIds: picked.map((g) => g.id),
    votes: {}, // votes[memberId][gameId] = { rating: 1..5|null, retire: bool }
    chosenGameId: null, // which game ends up being played
    chosenAt: null, // when a game was chosen
    finished: false, // whether the game was played/finished
    finishedAt: null, // when it was finished
    winnerIds: [], // winners (member ids, multiple allowed)
    cancelled: false, // final state: no game appealed, nothing was played
    cancelledAt: null, // when it was cancelled
    done: false,
  };
  round.sessions.push(session);
  saveData();

  // Convenience for the frontend: send the picked games right away.
  res.status(201).json({ session, games: picked, members });
});

// Save a session's complete result (hot-seat: all at once at the end).
router.post('/:sid/results', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const session = findSession(round, req.params.sid);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.votes = req.body.votes && typeof req.body.votes === 'object' ? req.body.votes : {};
  session.done = true;
  saveData();
  res.json(session);
});

// Remember the session's chosen game (or clear it with null).
router.post('/:sid/choice', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const session = findSession(round, req.params.sid);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.cancelled)
    return res.status(400).json({ error: 'Session is cancelled' });
  const gameId = req.body.gameId === null ? null : String(req.body.gameId || '');
  if (gameId !== null && !session.gameIds.includes(gameId))
    return res.status(400).json({ error: 'Game does not belong to this session' });

  session.chosenGameId = gameId;
  session.chosenAt = gameId ? new Date().toISOString() : null;
  saveData();
  res.json(session);
});

// Mark the game as played/finished and record winners (finished:false resets it).
router.post('/:sid/finish', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const session = findSession(round, req.params.sid);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const finished = req.body.finished !== false; // default: true
  if (!finished) {
    session.finished = false;
    session.finishedAt = null;
    session.winnerIds = [];
  } else {
    if (session.cancelled)
      return res.status(400).json({ error: 'Session is cancelled' });
    const ids = Array.isArray(req.body.winnerIds) ? req.body.winnerIds.map(String) : [];
    const memberIds = new Set(round.members.map((m) => m.id));
    session.winnerIds = ids.filter((mid) => memberIds.has(mid));
    session.finished = true;
    session.finishedAt = new Date().toISOString();
  }
  saveData();
  res.json(session);
});

// Cancel the session: no game appealed, nothing gets played (cancelled:false
// undoes it). A final state, mutually exclusive with choosing/finishing a game.
router.post('/:sid/cancel', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const session = findSession(round, req.params.sid);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const cancelled = req.body.cancelled !== false; // default: true
  if (cancelled) {
    if (session.chosenGameId || session.finished)
      return res.status(400).json({ error: 'A game is already chosen for this session' });
    session.cancelled = true;
    session.cancelledAt = new Date().toISOString();
  } else {
    session.cancelled = false;
    session.cancelledAt = null;
  }
  saveData();
  res.json(session);
});

// Remove a single game from a session: drop it from the game list and delete
// every member's vote for it. If it was the chosen/played game, that choice
// (and any recorded result) is reset too.
router.delete('/:sid/games/:gid', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const session = findSession(round, req.params.sid);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const gid = req.params.gid;
  if (!session.gameIds.includes(gid))
    return res.status(404).json({ error: 'Game does not belong to this session' });

  session.gameIds = session.gameIds.filter((x) => x !== gid);
  // Drop the game's votes from every member who cast one.
  Object.keys(session.votes || {}).forEach((mid) => {
    if (session.votes[mid]) delete session.votes[mid][gid];
  });
  // Removing the game that was going to be / was played invalidates that state.
  if (session.chosenGameId === gid) {
    session.chosenGameId = null;
    session.chosenAt = null;
    session.finished = false;
    session.finishedAt = null;
    session.winnerIds = [];
  }
  saveData();
  res.json(session);
});

router.delete('/:sid', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const idx = round.sessions.findIndex((s) => s.id === req.params.sid);
  if (idx === -1) return res.status(404).json({ error: 'Session not found' });
  round.sessions.splice(idx, 1);
  saveData();
  res.json({ ok: true });
});

module.exports = router;
