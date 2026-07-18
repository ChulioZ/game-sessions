'use strict';

/*
 * Data-access layer — JSON file backend (issue #127).
 *
 * The default backend (used unless DATABASE_URL is set — see ./index.js): the
 * in-memory tree from lib/store.js persisted to data/data.json. Keeps local dev
 * zero-dependency. The PostgreSQL backend (./postgres.js) implements this same
 * async contract, so routes never change when the backend does.
 *
 * The API is async (returns Promises) even though this backend is synchronous, so
 * the two backends are interchangeable; Express 5 forwards any rejection to the
 * central error handler (see lib/app.js).
 *
 * Reads (getRound/listRounds) return deep-cloned SNAPSHOTS: callers must persist
 * changes through the write methods below, not by mutating a returned object.
 * This mirrors a real database (a fetched row is a copy) and keeps this backend
 * honest about the same contract, so both backends behave alike.
 *
 * Not-found is signalled by a `null` return (never a throw), matching how the
 * routes branch to a 404 today.
 */

const { data, saveData, id } = require('../store');

const clone = (v) => (v == null ? v : structuredClone(v));

// Assembled-round snapshot WITHOUT the activity feed (issue #197): the feed is
// the only unbounded collection and only the Chronik view reads it, so it is
// served by listActivities() instead of riding along on every round fetch.
const snapshot = (round) => {
  if (!round) return null;
  const copy = clone(round);
  delete copy.activities;
  return copy;
};

// Live (mutable) round lookup — internal to the write methods only. Callers get
// snapshots; only the write path here touches the persisted tree.
const live = (rid) => data.rounds.find((r) => r.id === rid);

// Append an activity entry to a live round (the feed). Same shape as
// store.pushActivity, kept here so activity creation is part of the data layer.
function addActivity(round, type, payload) {
  if (!Array.isArray(round.activities)) round.activities = [];
  round.activities.push({ id: id(), type, at: new Date().toISOString(), ...payload });
}

/* ---------------------------------- Rounds --------------------------------- */

async function listRounds() {
  return data.rounds.map(snapshot);
}

async function getRound(rid) {
  return snapshot(live(rid));
}

// Create a round from already-validated input: `members` is a list of names,
// `importFromRoundId` optionally copies the active games (title/type/image only,
// as before) from an existing round.
async function createRound({ name, members, importFromRoundId }) {
  const round = {
    id: id(),
    name,
    members: members.map((nm) => ({ id: id(), name: nm })),
    games: [],
    sessions: [],
    activities: [],
    background: null,
  };

  const src = importFromRoundId ? live(importFromRoundId) : null;
  if (src) {
    src.games
      .filter((g) => !g.retired)
      .forEach((g) => {
        // Shares the same image file (files are never deleted); only
        // title/type/image are carried over, as the original import did.
        const ng = { id: id(), title: g.title, type: g.type, image: g.image, retired: false, retiredAt: null };
        round.games.push(ng);
        addActivity(round, 'game_added', { gameId: ng.id, title: ng.title });
      });
  }

  data.rounds.push(round);
  saveData();
  return snapshot(round);
}

async function deleteRound(rid) {
  const idx = data.rounds.findIndex((r) => r.id === rid);
  if (idx === -1) return false;
  data.rounds.splice(idx, 1);
  saveData();
  return true;
}

// Bulk-insert full round objects (the shape getRound returns) PRESERVING their
// ids, so every cross-reference stays valid — unlike createRound, which mints new
// ids. Used by the one-off data.json -> DB migration
// (scripts/migrate-json-to-postgres.js); implemented here too for interface
// symmetry and contract coverage. Appends; the caller ensures the target is empty
// or intended. Returns the number of rounds imported.
async function importRounds(rounds) {
  for (const round of rounds) data.rounds.push(structuredClone(round));
  saveData();
  return rounds.length;
}

/* --------------------------------- Members --------------------------------- */

// Apply a validated { name?, color? } patch. Returns the member, or null if the
// round or member is missing.
async function updateMember(rid, mid, patch) {
  const round = live(rid);
  if (!round) return null;
  const member = round.members.find((m) => m.id === mid);
  if (!member) return null;
  if (patch.name !== undefined) member.name = patch.name;
  if (patch.color !== undefined) member.color = patch.color;
  saveData();
  return clone(member);
}

/* ---------------------------------- Games ---------------------------------- */

// Create a game from resolved fields (title/platform/type/duration/min-max
// players/image, optional source). Mints the id, sets retired defaults and logs
// the game_added activity. Returns the game, or null if the round is gone.
async function createGame(rid, fields) {
  const round = live(rid);
  if (!round) return null;
  const game = {
    id: id(),
    title: fields.title,
    platform: fields.platform,
    type: fields.type,
    duration: fields.duration,
    minPlayers: fields.minPlayers,
    maxPlayers: fields.maxPlayers,
    image: fields.image,
    retired: false,
    retiredAt: null,
  };
  if (fields.source) game.source = fields.source;
  round.games.push(game);
  addActivity(round, 'game_added', { gameId: game.id, title: game.title });
  saveData();
  return clone(game);
}

// Apply a patch of already-resolved fields to a game (the route computes which
// keys change, including image handling). Returns the game, or null if missing.
async function updateGame(rid, gid, patch) {
  const round = live(rid);
  if (!round) return null;
  const game = round.games.find((g) => g.id === gid);
  if (!game) return null;
  Object.assign(game, patch);
  saveData();
  return clone(game);
}

async function retireGame(rid, gid, retired) {
  const round = live(rid);
  if (!round) return null;
  const game = round.games.find((g) => g.id === gid);
  if (!game) return null;
  game.retired = retired;
  game.retiredAt = retired ? new Date().toISOString() : null;
  addActivity(round, retired ? 'game_retired' : 'game_restored', { gameId: game.id, title: game.title });
  saveData();
  return clone(game);
}

// Permanently delete a retired game and scrub it from sessions + the feed.
// Returns null (game missing), 'not_retired' (refused), or { image } — the
// deleted game's cover path (may be null) so the caller can clean up the file.
async function deleteGame(rid, gid) {
  const round = live(rid);
  if (!round) return null;
  const idx = round.games.findIndex((g) => g.id === gid);
  if (idx === -1) return null;
  const game = round.games[idx];
  if (!game.retired) return 'not_retired';

  round.games.splice(idx, 1);

  // Scrub the game from every session of this round.
  round.sessions = round.sessions.filter((s) => {
    s.gameIds = s.gameIds.filter((x) => x !== game.id);
    if (s.gameIds.length === 0) return false; // session only contained this game
    for (const mid in s.votes || {}) delete s.votes[mid][game.id];
    if (s.chosenGameId === game.id) {
      s.chosenGameId = null;
      s.chosenAt = null;
      s.finished = false;
      s.finishedAt = null;
      s.winnerIds = [];
    }
    return true;
  });

  // Drop feed entries that reference the game, then log the deletion itself.
  if (Array.isArray(round.activities)) round.activities = round.activities.filter((a) => a.gameId !== game.id);
  addActivity(round, 'game_deleted', { title: game.title });

  saveData();
  return { image: game.image };
}

// Whether any game in any round still references this cover image path — the
// SSRF-safe "is the file still used?" check before unlinking it.
async function isImageReferenced(image) {
  return data.rounds.some((r) => r.games.some((g) => g.image === image));
}

/* --------------------------------- Sessions -------------------------------- */

// Persist a fully-built session object (the route owns the draw / direct-pick
// logic). Mints the id here. Returns the stored session, or null if round gone.
async function createSession(rid, session) {
  const round = live(rid);
  if (!round) return null;
  const full = { id: id(), ...session };
  round.sessions.push(full);
  saveData();
  return clone(full);
}

// Small internal helper: run `mutate(session)` on a live session and persist.
async function withSession(rid, sid, mutate) {
  const round = live(rid);
  if (!round) return null;
  const session = round.sessions.find((s) => s.id === sid);
  if (!session) return null;
  mutate(session);
  saveData();
  return clone(session);
}

async function saveSessionResults(rid, sid, votes) {
  return withSession(rid, sid, (s) => {
    s.votes = votes;
    s.done = true;
  });
}

async function setSessionChoice(rid, sid, gameId) {
  return withSession(rid, sid, (s) => {
    s.chosenGameId = gameId;
    s.chosenAt = gameId ? new Date().toISOString() : null;
  });
}

// Set/clear the played state. `winnerIds` is already filtered to real members.
async function finishSession(rid, sid, { finished, winnerIds }) {
  return withSession(rid, sid, (s) => {
    if (!finished) {
      s.finished = false;
      s.finishedAt = null;
      s.winnerIds = [];
    } else {
      s.winnerIds = winnerIds;
      s.finished = true;
      s.finishedAt = new Date().toISOString();
    }
  });
}

async function cancelSession(rid, sid, cancelled) {
  return withSession(rid, sid, (s) => {
    if (cancelled) {
      s.cancelled = true;
      s.cancelledAt = new Date().toISOString();
    } else {
      s.cancelled = false;
      s.cancelledAt = null;
    }
  });
}

// Remove one game from a session: drop it from the list + everyone's votes, and
// reset the choice/result if it was the chosen game.
async function removeSessionGame(rid, sid, gid) {
  return withSession(rid, sid, (s) => {
    s.gameIds = s.gameIds.filter((x) => x !== gid);
    Object.keys(s.votes || {}).forEach((mid) => {
      if (s.votes[mid]) delete s.votes[mid][gid];
    });
    if (s.chosenGameId === gid) {
      s.chosenGameId = null;
      s.chosenAt = null;
      s.finished = false;
      s.finishedAt = null;
      s.winnerIds = [];
    }
  });
}

async function deleteSession(rid, sid) {
  const round = live(rid);
  if (!round) return false;
  const idx = round.sessions.findIndex((s) => s.id === sid);
  if (idx === -1) return false;
  round.sessions.splice(idx, 1);
  saveData();
  return true;
}

/* -------------------------------- Activities ------------------------------- */

// The round's activity feed (newest last, as stored). Returns null when the
// round is missing — the feed is no longer part of getRound's snapshot.
async function listActivities(rid) {
  const round = live(rid);
  if (!round) return null;
  return clone(round.activities || []);
}

async function deleteActivity(rid, aid) {
  const round = live(rid);
  if (!round) return false;
  if (!Array.isArray(round.activities)) round.activities = [];
  const idx = round.activities.findIndex((a) => a.id === aid);
  if (idx === -1) return false;
  round.activities.splice(idx, 1);
  saveData();
  return true;
}

/* -------------------------------- Background -------------------------------- */

// Set the round's design. Returns { previous } (the prior background) so the
// caller can clean up a replaced collage image file, or null if the round gone.
async function setBackground(rid, bg) {
  const round = live(rid);
  if (!round) return null;
  const previous = clone(round.background);
  round.background = bg;
  saveData();
  return { previous };
}

/* ------------------------------ Recommendations ---------------------------- */

// Replace the round's recommendation run history (newest-first array) and retire
// the pre-#115 single `recommendations` object in the same write. Returns the
// stored runs, or null if the round is gone.
async function saveRecommendationRuns(rid, runs) {
  const round = live(rid);
  if (!round) return null;
  round.recommendationRuns = runs;
  delete round.recommendations;
  saveData();
  return clone(round.recommendationRuns);
}

// No-ops: the JSON backend needs no async setup or teardown (match postgres.js).
async function init() {}
async function end() {}

module.exports = {
  init,
  end,
  listRounds,
  getRound,
  createRound,
  deleteRound,
  importRounds,
  updateMember,
  createGame,
  updateGame,
  retireGame,
  deleteGame,
  isImageReferenced,
  createSession,
  saveSessionResults,
  setSessionChoice,
  finishSession,
  cancelSession,
  removeSessionGame,
  deleteSession,
  listActivities,
  deleteActivity,
  setBackground,
  saveRecommendationRuns,
};
