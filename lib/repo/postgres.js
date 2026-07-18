'use strict';

/*
 * Data-access layer — PostgreSQL backend (issue #127).
 *
 * Selected by ./index.js when DATABASE_URL is set. Implements the exact same
 * async contract as ./json.js (the documented shape lives there), so routes are
 * unchanged whichever backend runs. This is the stateless-app-tier persistence
 * the production roadmap needs (docs/production-readiness.md §3).
 *
 * Storage shape — a table per top-level entity, one row each, with the "messy"
 * nested bits kept as JSONB (votes maps, gameIds/winnerIds arrays, activity
 * payloads, the design) exactly as the roadmap sanctions ("JSONB where that's
 * genuinely simpler, need not fully normalize on day one"):
 *   rounds(id, tenant_id, name, background jsonb, recommendation_runs jsonb)
 *   members / games / sessions / activities (id, round_id -> rounds ON DELETE
 *   CASCADE, data jsonb)  — `data` holds every field except id/round_id.
 * `seq bigserial` preserves insertion order (arrays in the JSON model are
 * ordered), and `tenant_id` (default 'default') is the forward hook for the
 * later multi-tenancy work (#136) — this backend does not filter on it yet.
 *
 * Conventions:
 *  - Reads assemble plain objects fresh from the rows (like a DB snapshot), so a
 *    caller mutating a returned object never touches the store — same contract as
 *    the JSON backend.
 *  - JSONB params are passed as JSON text + cast `$n::jsonb` (node-postgres would
 *    otherwise turn a JS array into a Postgres array literal, not JSON).
 *  - Not-found -> `null`; never throws for it. SQL/connection errors do reject
 *    and reach the central error handler (Express 5 forwards them).
 */

const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Managed Postgres usually needs TLS; opt in with DATABASE_SSL=true (the CI
  // service container and local dev containers don't). Deploy wiring is #131.
  // Note: over a private/internal network (e.g. Railway's) leave it off — the
  // handshake is pure per-connection overhead there.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  // Keep pooled connections warm (TCP keep-alive) so a hosted DB / proxy is less
  // likely to drop them idle, which would force a slow reconnect on the next query.
  keepAlive: true,
  // Never evict idle clients (pg's default is 10s): the app's traffic is sporadic
  // bursts, so with eviction nearly every burst pays fresh TCP+auth connects —
  // measured as a real chunk of hosted request latency. Kept-open connections are
  // cheap for a dedicated managed Postgres (pool max is 10).
  idleTimeoutMillis: 0,
});

// With idle eviction off, the server/network CAN still kill an idle connection
// (restart, proxy timeout). pg then emits 'error' on the pool — unhandled, that
// crashes the process. Log it and move on: the pool discards the dead client and
// dials a fresh one on the next query.
pool.on('error', (err) => {
  require('../observability').logger.warn({ event: 'pg_pool_idle_error', message: err.message });
});

const newId = () => crypto.randomBytes(8).toString('hex');
const J = (v) => JSON.stringify(v);
const q = (text, params) => pool.query(text, params);

// Run fn inside a transaction on a dedicated client (BEGIN/COMMIT, ROLLBACK on
// throw). An early `return` with no writes commits an empty tx — harmless.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rounds (
  id text PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT 'default',
  name text NOT NULL,
  background jsonb,
  recommendation_runs jsonb,
  seq bigserial
);
CREATE TABLE IF NOT EXISTS members (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  seq bigserial
);
CREATE TABLE IF NOT EXISTS games (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  seq bigserial
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  seq bigserial
);
CREATE TABLE IF NOT EXISTS activities (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  seq bigserial
);
CREATE INDEX IF NOT EXISTS members_round_idx ON members(round_id, seq);
CREATE INDEX IF NOT EXISTS games_round_idx ON games(round_id, seq);
CREATE INDEX IF NOT EXISTS sessions_round_idx ON sessions(round_id, seq);
CREATE INDEX IF NOT EXISTS activities_round_idx ON activities(round_id, seq);
CREATE INDEX IF NOT EXISTS games_image_idx ON games((data->>'image'));
`;

// Ensure the schema exists. Idempotent (IF NOT EXISTS). A caller runs this once
// before serving (server.js awaits repo.init() before listen).
async function init() {
  await pool.query(SCHEMA);
}

async function end() {
  await pool.end();
}

// Re-attach the id column and merge the JSONB `data` back into one flat object,
// reproducing the JSON model's entity shape ({ id, ...fields }).
const withId = (row) => ({ id: row.id, ...row.data });

// Assemble the nested round object from its row + child rows, in the same key
// order the JSON backend builds. The activity feed is NOT part of it (issue
// #197 — it is unbounded and only Chronik reads it, via listActivities()).
// background is always present (may be null); recommendationRuns only when it
// has ever been written (matches the JSON model, where the key is absent until
// saveRecommendationRuns runs).
function assemble(round, children) {
  const out = {
    id: round.id,
    name: round.name,
    members: children.members.map(withId),
    games: children.games.map(withId),
    sessions: children.sessions.map(withId),
    background: round.background ?? null,
  };
  if (round.recommendation_runs != null) out.recommendationRuns = round.recommendation_runs;
  return out;
}

// Fetch a round's assembled child collections (ordered) on the given querier.
// Awaited one at a time on purpose: `querier` may be a single transaction
// client, which cannot run concurrent queries (Promise.all would; pg 9 will
// reject it).
async function childrenOf(querier, rid) {
  const members = await querier('SELECT id, data FROM members WHERE round_id = $1 ORDER BY seq', [rid]);
  const games = await querier('SELECT id, data FROM games WHERE round_id = $1 ORDER BY seq', [rid]);
  const sessions = await querier('SELECT id, data FROM sessions WHERE round_id = $1 ORDER BY seq', [rid]);
  return { members: members.rows, games: games.rows, sessions: sessions.rows };
}

// Append an activity row (feed). Same {type, at, ...payload} shape as the JSON
// backend, minus the id (that's the row's own column).
async function addActivity(querier, rid, type, payload) {
  const data = { type, at: new Date().toISOString(), ...payload };
  await querier('INSERT INTO activities(id, round_id, data) VALUES ($1, $2, $3::jsonb)', [newId(), rid, J(data)]);
}

/* ---------------------------------- Rounds --------------------------------- */

async function listRounds() {
  const rounds = await q('SELECT id, name, background, recommendation_runs FROM rounds ORDER BY seq');
  if (rounds.rows.length === 0) return [];
  const ids = rounds.rows.map((r) => r.id);
  const [members, games, sessions] = await Promise.all([
    q('SELECT id, round_id, data FROM members WHERE round_id = ANY($1) ORDER BY seq', [ids]),
    q('SELECT id, round_id, data FROM games WHERE round_id = ANY($1) ORDER BY seq', [ids]),
    q('SELECT id, round_id, data FROM sessions WHERE round_id = ANY($1) ORDER BY seq', [ids]),
  ]);
  const group = (rows) => {
    const m = new Map();
    for (const row of rows) {
      if (!m.has(row.round_id)) m.set(row.round_id, []);
      m.get(row.round_id).push(row);
    }
    return m;
  };
  const mm = group(members.rows), mg = group(games.rows), ms = group(sessions.rows);
  return rounds.rows.map((r) =>
    assemble(r, {
      members: mm.get(r.id) || [],
      games: mg.get(r.id) || [],
      sessions: ms.get(r.id) || [],
    })
  );
}

async function getRound(rid) {
  // Fetch the round and its child collections CONCURRENTLY. Unlike childrenOf's
  // transaction callers (a single client can't run concurrent queries), getRound
  // reads on the pool, so each query gets its own connection and they run in
  // parallel — collapsing the sequential round-trips into one. That round-trip
  // count dominates latency to a hosted Postgres (a sequential fetch measured
  // ~1s there); listRounds already fetches this way.
  const [r, members, games, sessions] = await Promise.all([
    q('SELECT id, name, background, recommendation_runs FROM rounds WHERE id = $1', [rid]),
    q('SELECT id, data FROM members WHERE round_id = $1 ORDER BY seq', [rid]),
    q('SELECT id, data FROM games WHERE round_id = $1 ORDER BY seq', [rid]),
    q('SELECT id, data FROM sessions WHERE round_id = $1 ORDER BY seq', [rid]),
  ]);
  if (!r.rows[0]) return null;
  return assemble(r.rows[0], { members: members.rows, games: games.rows, sessions: sessions.rows });
}

async function createRound({ name, members, importFromRoundId }) {
  return tx(async (c) => {
    const cq = (t, p) => c.query(t, p);
    const rid = newId();
    await cq('INSERT INTO rounds(id, name, background) VALUES ($1, $2, NULL)', [rid, name]);
    for (const nm of members) {
      await cq('INSERT INTO members(id, round_id, data) VALUES ($1, $2, $3::jsonb)', [newId(), rid, J({ name: nm })]);
    }
    if (importFromRoundId) {
      // Active games only, copying just title/type/image (as the JSON import did).
      const src = await cq(
        "SELECT data FROM games WHERE round_id = $1 AND (data->>'retired')::boolean IS NOT TRUE ORDER BY seq",
        [importFromRoundId]
      );
      for (const row of src.rows) {
        const gid = newId();
        const data = { title: row.data.title, type: row.data.type, image: row.data.image, retired: false, retiredAt: null };
        await cq('INSERT INTO games(id, round_id, data) VALUES ($1, $2, $3::jsonb)', [gid, rid, J(data)]);
        await addActivity(cq, rid, 'game_added', { gameId: gid, title: data.title });
      }
    }
    const round = await cq('SELECT id, name, background, recommendation_runs FROM rounds WHERE id = $1', [rid]);
    return assemble(round.rows[0], await childrenOf(cq, rid));
  });
}

async function deleteRound(rid) {
  const r = await q('DELETE FROM rounds WHERE id = $1', [rid]);
  return r.rowCount > 0;
}

// Bulk-insert full round objects (the shape getRound returns) PRESERVING their
// ids — the inverse of assemble(), and unlike createRound it does not mint new
// ids, so every cross-reference stays valid. Used by the one-off data.json -> DB
// migration (scripts/migrate-json-to-postgres.js). One transaction for the whole
// import. Table names are static literals (no interpolation). Returns the count.
async function importRounds(rounds) {
  return tx(async (c) => {
    for (const round of rounds) {
      await c.query(
        'INSERT INTO rounds(id, name, background, recommendation_runs) VALUES ($1, $2, $3::jsonb, $4::jsonb)',
        [
          round.id,
          round.name,
          round.background == null ? null : J(round.background),
          round.recommendationRuns == null ? null : J(round.recommendationRuns),
        ]
      );
      for (const m of round.members || []) {
        const { id, ...data } = m;
        await c.query('INSERT INTO members(id, round_id, data) VALUES ($1, $2, $3::jsonb)', [id, round.id, J(data)]);
      }
      for (const g of round.games || []) {
        const { id, ...data } = g;
        await c.query('INSERT INTO games(id, round_id, data) VALUES ($1, $2, $3::jsonb)', [id, round.id, J(data)]);
      }
      for (const s of round.sessions || []) {
        const { id, ...data } = s;
        await c.query('INSERT INTO sessions(id, round_id, data) VALUES ($1, $2, $3::jsonb)', [id, round.id, J(data)]);
      }
      for (const a of round.activities || []) {
        const { id, ...data } = a;
        await c.query('INSERT INTO activities(id, round_id, data) VALUES ($1, $2, $3::jsonb)', [id, round.id, J(data)]);
      }
    }
    return rounds.length;
  });
}

/* --------------------------------- Members --------------------------------- */

async function updateMember(rid, mid, patch) {
  const r = await q(
    'UPDATE members SET data = data || $1::jsonb WHERE id = $2 AND round_id = $3 RETURNING id, data',
    [J(patch), mid, rid]
  );
  return r.rows[0] ? withId(r.rows[0]) : null;
}

/* ---------------------------------- Games ---------------------------------- */

async function createGame(rid, fields) {
  return tx(async (c) => {
    const exists = await c.query('SELECT 1 FROM rounds WHERE id = $1', [rid]);
    if (!exists.rows[0]) return null;
    const gid = newId();
    const data = {
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
    if (fields.source) data.source = fields.source;
    await c.query('INSERT INTO games(id, round_id, data) VALUES ($1, $2, $3::jsonb)', [gid, rid, J(data)]);
    await addActivity((t, p) => c.query(t, p), rid, 'game_added', { gameId: gid, title: data.title });
    return { id: gid, ...data };
  });
}

async function updateGame(rid, gid, patch) {
  const r = await q(
    'UPDATE games SET data = data || $1::jsonb WHERE id = $2 AND round_id = $3 RETURNING id, data',
    [J(patch), gid, rid]
  );
  return r.rows[0] ? withId(r.rows[0]) : null;
}

async function retireGame(rid, gid, retired) {
  return tx(async (c) => {
    const patch = { retired, retiredAt: retired ? new Date().toISOString() : null };
    const r = await c.query(
      'UPDATE games SET data = data || $1::jsonb WHERE id = $2 AND round_id = $3 RETURNING id, data',
      [J(patch), gid, rid]
    );
    if (!r.rows[0]) return null;
    await addActivity((t, p) => c.query(t, p), rid, retired ? 'game_retired' : 'game_restored', {
      gameId: gid,
      title: r.rows[0].data.title,
    });
    return withId(r.rows[0]);
  });
}

async function deleteGame(rid, gid) {
  return tx(async (c) => {
    const g = await c.query('SELECT data FROM games WHERE id = $1 AND round_id = $2', [gid, rid]);
    if (!g.rows[0]) return null;
    const game = g.rows[0].data;
    if (!game.retired) return 'not_retired';

    await c.query('DELETE FROM games WHERE id = $1', [gid]);

    // Scrub the game from every session of this round (same rules as the JSON
    // backend): drop it from gameIds + all votes, reset the choice if it was the
    // chosen game, and delete sessions that end up empty.
    const sessions = await c.query('SELECT id, data FROM sessions WHERE round_id = $1', [rid]);
    for (const row of sessions.rows) {
      const s = row.data;
      s.gameIds = (s.gameIds || []).filter((x) => x !== gid);
      if (s.gameIds.length === 0) {
        await c.query('DELETE FROM sessions WHERE id = $1', [row.id]);
        continue;
      }
      for (const mid in s.votes || {}) delete s.votes[mid][gid];
      if (s.chosenGameId === gid) {
        s.chosenGameId = null;
        s.chosenAt = null;
        s.finished = false;
        s.finishedAt = null;
        s.winnerIds = [];
      }
      await c.query('UPDATE sessions SET data = $1::jsonb WHERE id = $2', [J(s), row.id]);
    }

    // Drop feed entries that reference the game, then log the deletion itself.
    await c.query("DELETE FROM activities WHERE round_id = $1 AND data->>'gameId' = $2", [rid, gid]);
    await addActivity((t, p) => c.query(t, p), rid, 'game_deleted', { title: game.title });

    return { image: game.image };
  });
}

async function isImageReferenced(image) {
  const r = await q("SELECT 1 FROM games WHERE data->>'image' = $1 LIMIT 1", [image]);
  return r.rows.length > 0;
}

/* --------------------------------- Sessions -------------------------------- */

async function createSession(rid, session) {
  return tx(async (c) => {
    const exists = await c.query('SELECT 1 FROM rounds WHERE id = $1', [rid]);
    if (!exists.rows[0]) return null;
    const sid = newId();
    await c.query('INSERT INTO sessions(id, round_id, data) VALUES ($1, $2, $3::jsonb)', [sid, rid, J(session)]);
    return { id: sid, ...session };
  });
}

// Load a session row FOR UPDATE, apply `mutate` (the same closures the JSON
// backend uses) and write it back — one atomic read-modify-write per row.
async function withSession(rid, sid, mutate) {
  return tx(async (c) => {
    const r = await c.query('SELECT data FROM sessions WHERE id = $1 AND round_id = $2 FOR UPDATE', [sid, rid]);
    if (!r.rows[0]) return null;
    const data = r.rows[0].data;
    mutate(data);
    await c.query('UPDATE sessions SET data = $1::jsonb WHERE id = $2', [J(data), sid]);
    return { id: sid, ...data };
  });
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
  const r = await q('DELETE FROM sessions WHERE id = $1 AND round_id = $2', [sid, rid]);
  return r.rowCount > 0;
}

/* -------------------------------- Activities ------------------------------- */

// The round's activity feed (insertion order, like the JSON model's array).
// Returns null when the round is missing — the feed is not part of getRound.
async function listActivities(rid) {
  const [r, acts] = await Promise.all([
    q('SELECT 1 FROM rounds WHERE id = $1', [rid]),
    q('SELECT id, data FROM activities WHERE round_id = $1 ORDER BY seq', [rid]),
  ]);
  if (!r.rows[0]) return null;
  return acts.rows.map(withId);
}

async function deleteActivity(rid, aid) {
  const r = await q('DELETE FROM activities WHERE id = $1 AND round_id = $2', [aid, rid]);
  return r.rowCount > 0;
}

/* -------------------------------- Background -------------------------------- */

async function setBackground(rid, bg) {
  return tx(async (c) => {
    const r = await c.query('SELECT background FROM rounds WHERE id = $1', [rid]);
    if (!r.rows[0]) return null;
    const previous = r.rows[0].background ?? null;
    await c.query('UPDATE rounds SET background = $1::jsonb WHERE id = $2', [J(bg), rid]);
    return { previous };
  });
}

/* ------------------------------ Recommendations ---------------------------- */

async function saveRecommendationRuns(rid, runs) {
  const r = await q(
    'UPDATE rounds SET recommendation_runs = $1::jsonb WHERE id = $2 RETURNING recommendation_runs',
    [J(runs), rid]
  );
  return r.rows[0] ? r.rows[0].recommendation_runs : null;
}

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
