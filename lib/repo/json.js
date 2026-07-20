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
 *
 * Tenancy (issue #136): every round-scoped method takes the caller's tenant id
 * first and only ever sees that tenant's rounds — a wrong-tenant lookup is
 * indistinguishable from not-found. Rounds store it as `tenantId`; rows written
 * before tenancy have no key and count as tenant 'default' (the single
 * pre-tenancy group). The field is internal: snapshots strip it, so the API
 * payloads don't change shape.
 */

const { data, saveData, id } = require('../store');

const clone = (v) => (v == null ? v : structuredClone(v));

// The tenant a stored round belongs to (pre-tenancy rows have no tenantId).
const tenantOf = (round) => round.tenantId || 'default';

// Assembled-round snapshot WITHOUT the activity feed (issue #197): the feed is
// the only unbounded collection and only the Chronik view reads it, so it is
// served by listActivities() instead of riding along on every round fetch.
// tenantId is scoping metadata, not payload — stripped like the feed.
const snapshot = (round) => {
  if (!round) return null;
  const copy = clone(round);
  delete copy.activities;
  delete copy.tenantId;
  return copy;
};

// Live (mutable) round lookup — internal to the write methods only, and the
// single place the tenant filter is applied. Callers get snapshots; only the
// write path here touches the persisted tree.
const live = (tenant, rid) => data.rounds.find((r) => r.id === rid && tenantOf(r) === tenant);

// Append an activity entry to a live round (the feed). Same shape as
// store.pushActivity, kept here so activity creation is part of the data layer.
function addActivity(round, type, payload) {
  if (!Array.isArray(round.activities)) round.activities = [];
  round.activities.push({ id: id(), type, at: new Date().toISOString(), ...payload });
}

/* ---------------------------------- Rounds --------------------------------- */

async function listRounds(tenant) {
  return data.rounds.filter((r) => tenantOf(r) === tenant).map(snapshot);
}

async function getRound(tenant, rid) {
  return snapshot(live(tenant, rid));
}

// Create a round from already-validated input: `members` is a list of names,
// `importFromRoundId` optionally copies the active games (title/image only) from
// an existing round — of the same tenant only.
async function createRound(tenant, { name, members, importFromRoundId }) {
  const round = {
    id: id(),
    tenantId: tenant,
    name,
    members: members.map((nm) => ({ id: id(), name: nm })),
    games: [],
    sessions: [],
    activities: [],
    background: null,
  };

  const src = importFromRoundId ? live(tenant, importFromRoundId) : null;
  if (src) {
    src.games
      .filter((g) => !g.retired)
      .forEach((g) => {
        // Shares the same image file (files are never deleted); only
        // title/image are carried over.
        const ng = { id: id(), title: g.title, image: g.image, retired: false, retiredAt: null };
        round.games.push(ng);
        addActivity(round, 'game_added', { gameId: ng.id, title: ng.title });
      });
  }

  data.rounds.push(round);
  saveData();
  return snapshot(round);
}

async function deleteRound(tenant, rid) {
  const idx = data.rounds.findIndex((r) => r.id === rid && tenantOf(r) === tenant);
  if (idx === -1) return false;
  data.rounds.splice(idx, 1);
  saveData();
  return true;
}

/* ---------------------------------- Users ----------------------------------- */
/*
 * Accounts (issue #135) live OUTSIDE rounds — top-level data.users, global (not
 * tenant-scoped): users are the identity layer tenants hang off, looked up by
 * email at login before any tenant is known. Each user carries the `tenantId`
 * it acts as (#136; minted at registration). Every key is always present (null
 * when unset) so both backends round-trip identically (see
 * .claude/rules/postgres-backend.md on absent-key parity). updateUser replaces
 * whole top-level keys (arrays/objects included), matching jsonb `||` semantics.
 */

// Insert a user from route-built fields (email pre-normalized, hashes computed).
// Mints the id. Returns the user, or 'email_taken' when the email exists.
async function createUser(fields) {
  if (data.users.some((u) => u.email === fields.email)) return 'email_taken';
  const user = { id: id(), ...fields };
  data.users.push(user);
  saveData();
  return clone(user);
}

async function getUserById(uid) {
  return clone(data.users.find((u) => u.id === uid) || null);
}

async function getUserByEmail(email) {
  return clone(data.users.find((u) => u.email === email) || null);
}

// Replace whole top-level keys with the patch's values. Returns user or null.
async function updateUser(uid, patch) {
  const user = data.users.find((u) => u.id === uid);
  if (!user) return null;
  Object.assign(user, patch);
  saveData();
  return clone(user);
}

async function deleteUser(uid) {
  const idx = data.users.findIndex((u) => u.id === uid);
  if (idx === -1) return false;
  data.users.splice(idx, 1);
  saveData();
  return true;
}

// Every user, for the operator's account list (issue #268). Global like the
// other user methods. The ROUTE is responsible for stripping secrets before
// this reaches a response — the repo returns the stored shape, as it does
// everywhere else.
async function listUsers() {
  return data.users.map((u) => clone(u));
}

/* -------------------------------- Moderation -------------------------------- */
/*
 * Operator tooling (issue #268) — deliberately GLOBAL (cross-tenant), because an
 * abuse notice names an image, not a tenant. These are the only repo methods that
 * intentionally see past the tenant boundary, so they are NOT in TENANT_METHODS
 * and a route reaches them via the module-level repo, never req.repo.
 */

// Resolve a stored '/uploads/<key>' cover path to its owning game/round/tenant.
// Returns null when no game references it (an orphaned object, or already taken
// down). Matches the exact stored string, the same comparison isImageReferenced
// uses — a key is only ever stored in that one canonical form.
async function findImageOwner(image) {
  for (const round of data.rounds) {
    const game = round.games.find((g) => g.image === image);
    if (game) {
      return {
        image,
        tenantId: tenantOf(round),
        roundId: round.id,
        roundName: round.name,
        gameId: game.id,
        gameTitle: game.title,
      };
    }
  }
  return null;
}

// Clear the cover from every game referencing this path, across all tenants.
// Returns the number of games changed (0 when nothing referenced it), so the
// caller can report an already-clean object honestly instead of claiming a
// takedown that did nothing. The stored object itself is removed by the route
// via lib/storage, mirroring how deleteGame hands the path back for cleanup.
async function takedownImage(image) {
  let cleared = 0;
  for (const round of data.rounds) {
    for (const game of round.games) {
      if (game.image === image) {
        game.image = null;
        cleared += 1;
      }
    }
  }
  if (cleared) saveData();
  return cleared;
}

// Clear EVERY game's cover and provider source link, across every tenant, and
// report what changed. The one-time operator sweep from #172: the app stopped
// re-hosting provider cover art (it hotlinks now), and this retires the copies
// made under the old behaviour. Deliberately blunt — it drops user uploads and
// hotlinks alike, because the operator cannot tell from a stored path which
// re-hosted file came from a provider, and the games are re-linkable by hand.
// The stored objects are deleted by the route via lib/storage.removeAll().
async function purgeAllCovers() {
  let images = 0;
  let sources = 0;
  for (const round of data.rounds) {
    for (const game of round.games) {
      if (game.image) { game.image = null; images += 1; }
      if (game.source) { game.source = null; sources += 1; }
    }
  }
  if (images || sources) saveData();
  return { images, sources };
}

/* --------------------------- Erasure & export (#273) ------------------------ */
/*
 * Art. 17 (erasure) and Art. 15/20 (access/portability), operator-side. Global
 * like the rest of this section: the operator names an ACCOUNT, and the account
 * is what carries the tenant id — so these take a uid/tenant rather than riding
 * on req.repo.
 */

// Everything held for one tenant, for an access request. Unlike a snapshot this
// DOES include the activity feed: "everything you hold about me" has to mean
// everything, and the feed is held data (snapshots strip it only because it is
// unbounded and no view needs it — issue #197). tenantId is still stripped: it
// is our scoping metadata, not the subject's data.
async function exportTenant(tenant) {
  if (!tenant) return { tenantId: null, rounds: [] };
  const rounds = data.rounds
    .filter((r) => tenantOf(r) === tenant)
    .map((r) => {
      const copy = clone(r);
      delete copy.tenantId;
      return copy;
    });
  return { tenantId: tenant, rounds };
}

// Erase an account AND its tenant's round data, returning the freed
// '/uploads/<key>' paths so the ROUTE can delete the stored objects — the same
// clear-the-reference-then-delete-the-bytes ordering takedownImage uses, so a
// failure to delete bytes can never leave a row pointing at a missing object.
//
// Returns null when the account is unknown, the marker 'tenant_shared' when
// another account still lives on the same tenant (see below), else
// { tenantId, rounds, images }.
async function eraseAccount(uid) {
  // Held as an INDEX, not just the object: the removal below must never be
  // splice(findIndex(...), 1) — a -1 there silently deletes the LAST user
  // instead, i.e. erases the wrong person. Unreachable given the guard, but not
  // a shape to leave lying around in erasure code.
  const idx = data.users.findIndex((u) => u.id === uid);
  if (idx === -1) return null;
  const user = data.users[idx];
  const tenant = user.tenantId || null;

  // Erasure cascades the whole TENANT, so it must not run while a second
  // account still lives there — that round data is partly theirs, and erasing
  // it would be an unrequested deletion of a third party's data. Unreachable
  // today (registration mints a personal tenant per user) but tenant sharing is
  // planned (#207), and this is the failure mode you cannot undo afterwards.
  if (tenant && data.users.some((u) => u.id !== uid && (u.tenantId || null) === tenant)) {
    return 'tenant_shared';
  }

  // A cover path can be referenced by several games at once: createRound's
  // importFromRoundId copies the path rather than the file. Deduped so the route
  // deletes each object once. Import is same-tenant only, so no path collected
  // here can still be referenced by a surviving tenant.
  const images = new Set();
  let rounds = 0;
  if (tenant) {
    for (let i = data.rounds.length - 1; i >= 0; i -= 1) {
      const round = data.rounds[i];
      if (tenantOf(round) !== tenant) continue;
      for (const game of round.games) if (game.image) images.add(game.image);
      data.rounds.splice(i, 1);
      rounds += 1;
    }
  }

  data.users.splice(idx, 1);
  saveData();
  return { tenantId: tenant, rounds, images: [...images] };
}

// Append one operator action to the audit record. `entry` is route-built
// ({ action, target, reason, at, ... }); the id is minted here.
async function logModeration(entry) {
  const row = { id: id(), ...entry };
  data.moderationLog.push(row);
  saveData();
  return clone(row);
}

// Most recent actions first.
async function listModeration(limit = 100) {
  return data.moderationLog.slice(-limit).reverse().map((e) => clone(e));
}

/* --------------------------------- Members --------------------------------- */

// Apply a validated { name?, color?, userId? } patch (userId: the optional link
// to an account, #135 — null unlinks). Returns the member, or null if the round
// or member is missing.
async function updateMember(tenant, rid, mid, patch) {
  const round = live(tenant, rid);
  if (!round) return null;
  const member = round.members.find((m) => m.id === mid);
  if (!member) return null;
  if (patch.name !== undefined) member.name = patch.name;
  if (patch.color !== undefined) member.color = patch.color;
  if (patch.userId !== undefined) member.userId = patch.userId;
  saveData();
  return clone(member);
}

/* ---------------------------------- Games ---------------------------------- */

// Create a game from resolved fields (title/min-max players/image, optional
// source). Mints the id, sets retired defaults and logs the game_added activity.
// Returns the game, or null if the round is gone.
async function createGame(tenant, rid, fields) {
  const round = live(tenant, rid);
  if (!round) return null;
  const game = {
    id: id(),
    title: fields.title,
    minPlayers: fields.minPlayers,
    maxPlayers: fields.maxPlayers,
    image: fields.image,
    retired: false,
    retiredAt: null,
  };
  if (fields.source) game.source = fields.source;
  if (Array.isArray(fields.tagIds) && fields.tagIds.length) game.tagIds = fields.tagIds;
  round.games.push(game);
  addActivity(round, 'game_added', { gameId: game.id, title: game.title });
  saveData();
  return clone(game);
}

// Apply a patch of already-resolved fields to a game (the route computes which
// keys change, including image handling). Returns the game, or null if missing.
async function updateGame(tenant, rid, gid, patch) {
  const round = live(tenant, rid);
  if (!round) return null;
  const game = round.games.find((g) => g.id === gid);
  if (!game) return null;
  Object.assign(game, patch);
  saveData();
  return clone(game);
}

async function retireGame(tenant, rid, gid, retired) {
  const round = live(tenant, rid);
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
async function deleteGame(tenant, rid, gid) {
  const round = live(tenant, rid);
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

// Whether any game in any of the tenant's rounds still references this cover
// image path — the SSRF-safe "is the file still used?" check before unlinking
// it. Tenant-scoped: image files never cross tenants (imports copy paths only
// within a tenant), and the Postgres backend couldn't see past RLS anyway.
async function isImageReferenced(tenant, image) {
  return data.rounds.some((r) => tenantOf(r) === tenant && r.games.some((g) => g.image === image));
}

/* --------------------------------- Sessions -------------------------------- */

// Persist a fully-built session object (the route owns the draw / direct-pick
// logic). Mints the id here. Returns the stored session, or null if round gone.
// `filters` ({ tagIds, excludeTagIds, count }) is the draw-flow's remembered
// session-start preset (#252), stored on the round as part of the same
// mutation. Direct-pick sessions pass nothing, so they never overwrite it.
async function createSession(tenant, rid, session, filters) {
  const round = live(tenant, rid);
  if (!round) return null;
  const full = { id: id(), ...session };
  round.sessions.push(full);
  if (filters) round.lastSessionFilters = filters;
  saveData();
  return clone(full);
}

// Small internal helper: run `mutate(session)` on a live session and persist.
async function withSession(tenant, rid, sid, mutate) {
  const round = live(tenant, rid);
  if (!round) return null;
  const session = round.sessions.find((s) => s.id === sid);
  if (!session) return null;
  mutate(session);
  saveData();
  return clone(session);
}

async function saveSessionResults(tenant, rid, sid, votes) {
  return withSession(tenant, rid, sid, (s) => {
    s.votes = votes;
    s.done = true;
  });
}

async function setSessionChoice(tenant, rid, sid, gameId) {
  return withSession(tenant, rid, sid, (s) => {
    s.chosenGameId = gameId;
    s.chosenAt = gameId ? new Date().toISOString() : null;
  });
}

// Set/clear the played state. `winnerIds` is already filtered to real members.
async function finishSession(tenant, rid, sid, { finished, winnerIds }) {
  return withSession(tenant, rid, sid, (s) => {
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

async function cancelSession(tenant, rid, sid, cancelled) {
  return withSession(tenant, rid, sid, (s) => {
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
async function removeSessionGame(tenant, rid, sid, gid) {
  return withSession(tenant, rid, sid, (s) => {
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

async function deleteSession(tenant, rid, sid) {
  const round = live(tenant, rid);
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
async function listActivities(tenant, rid) {
  const round = live(tenant, rid);
  if (!round) return null;
  return clone(round.activities || []);
}

async function deleteActivity(tenant, rid, aid) {
  const round = live(tenant, rid);
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
async function setBackground(tenant, rid, bg) {
  const round = live(tenant, rid);
  if (!round) return null;
  const previous = clone(round.background);
  round.background = bg;
  saveData();
  return { previous };
}

/* ----------------------------------- Tags ----------------------------------- */

// Create a round-level tag (#238). A name matching an existing tag (the caller
// trims; compared case-insensitively) reuses that tag instead of duplicating
// it. Returns the (existing or new) tag, or null if the round is gone. The
// `tags` key stays absent until the first tag is created (absent-key parity
// with the Postgres backend's NULL column).
async function addTag(tenant, rid, name) {
  const round = live(tenant, rid);
  if (!round) return null;
  if (!Array.isArray(round.tags)) round.tags = [];
  const existing = round.tags.find((tg) => tg.name.toLowerCase() === name.toLowerCase());
  if (existing) return clone(existing);
  const tag = { id: id(), name };
  round.tags.push(tag);
  saveData();
  return clone(tag);
}

// Delete a round tag and silently unassign it from every game that had it.
// Returns true/false (found) — a missing round reads like a missing tag.
async function deleteTag(tenant, rid, tagId) {
  const round = live(tenant, rid);
  if (!round) return false;
  const idx = (round.tags || []).findIndex((tg) => tg.id === tagId);
  if (idx === -1) return false;
  round.tags.splice(idx, 1);
  round.games.forEach((g) => {
    if (Array.isArray(g.tagIds)) g.tagIds = g.tagIds.filter((x) => x !== tagId);
  });
  saveData();
  return true;
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
  createUser,
  getUserById,
  getUserByEmail,
  updateUser,
  deleteUser,
  listUsers,
  findImageOwner,
  takedownImage,
  purgeAllCovers,
  exportTenant,
  eraseAccount,
  logModeration,
  listModeration,
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
  addTag,
  deleteTag,
};
