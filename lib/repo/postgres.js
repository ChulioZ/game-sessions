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
 *   CASCADE, tenant_id, data jsonb)  — `data` holds every field except
 *   id/round_id.
 * `seq bigserial` preserves insertion order (arrays in the JSON model are
 * ordered).
 *
 * Tenancy (issue #136) — two independent layers, so a slip in one can't leak:
 *  1. App layer: every round-scoped method takes the tenant first and every SQL
 *     statement filters/writes `tenant_id` explicitly (children carry it
 *     denormalized so a guessed round_id+child_id can't cross tenants).
 *  2. Row-Level Security: the round tables ENABLE + FORCE row level security
 *     with policies comparing tenant_id to the per-transaction setting
 *     `app.tenant_id`. Every tenant-scoped statement runs inside a transaction
 *     that sets it (tx/qt below). FORCE means even the table owner (the role
 *     Railway/CI connect as) is subject; `current_setting(..., true)` yields
 *     NULL when unset, so a query outside tx/qt sees NO rows — fail-closed,
 *     never fail-open.
 * The users table is NOT tenant-scoped: users are the identity layer (looked up
 * by email at login, before any tenant is known) and carry their tenantId in
 * `data` instead.
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
// Plain pool query — ONLY for the users table (not tenant-scoped, no RLS) and
// internals. Anything touching the round tables must go through tx/qt, or RLS
// hides every row (fail-closed by design).
const q = (text, params) => pool.query(text, params);

// Run fn inside a transaction on a dedicated client (BEGIN/COMMIT, ROLLBACK on
// throw). An early `return` with no writes commits an empty tx — harmless.
// When `tenant` is non-null, the transaction sets the RLS scope `app.tenant_id`
// (SET LOCAL semantics via set_config(..., true): it dies with the transaction,
// so no tenant ever leaks to the next pooled checkout). init() passes null for
// its DDL — schema changes aren't row-filtered.
async function tx(tenant, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenant != null) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenant)]);
    }
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

// One tenant-scoped statement in its own little transaction (the RLS setting
// only exists inside one — see tx). Costs BEGIN/SET/COMMIT round trips, which
// over the deploy's private network are ~a millisecond; independent qt() calls
// still parallelize (each gets its own pooled connection).
const qt = (tenant, text, params) => tx(tenant, (c) => c.query(text, params));

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
  tenant_id text NOT NULL DEFAULT 'default',
  data jsonb NOT NULL,
  seq bigserial
);
CREATE TABLE IF NOT EXISTS games (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'default',
  data jsonb NOT NULL,
  seq bigserial
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'default',
  data jsonb NOT NULL,
  seq bigserial
);
CREATE TABLE IF NOT EXISTS activities (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'default',
  data jsonb NOT NULL,
  seq bigserial
);
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  seq bigserial
);
-- Schema evolution for databases created before tenancy (#136): the child
-- tables gain tenant_id, backfilled to the pre-tenancy single group. Idempotent,
-- like everything in this block. (rounds got the column at creation, #127.)
ALTER TABLE members    ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
ALTER TABLE games      ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
ALTER TABLE sessions   ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
ALTER TABLE activities ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users((data->>'email'));
CREATE INDEX IF NOT EXISTS rounds_tenant_idx ON rounds(tenant_id, seq);
CREATE INDEX IF NOT EXISTS members_round_idx ON members(round_id, seq);
CREATE INDEX IF NOT EXISTS games_round_idx ON games(round_id, seq);
CREATE INDEX IF NOT EXISTS sessions_round_idx ON sessions(round_id, seq);
CREATE INDEX IF NOT EXISTS activities_round_idx ON activities(round_id, seq);
CREATE INDEX IF NOT EXISTS games_image_idx ON games((data->>'image'));
`;

// Row-Level Security (#136, defense-in-depth): kept apart from SCHEMA only for
// readability — init() runs both. CREATE POLICY has no IF NOT EXISTS, hence
// DROP+CREATE (cheap, and serialized by init's advisory lock). FORCE makes the
// policies bind the table owner too — Railway/CI connect as exactly that role,
// so without FORCE the whole layer would silently not apply.
const RLS_TABLES = ['rounds', 'members', 'games', 'sessions', 'activities'];
const RLS = RLS_TABLES.map((t) => `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${t}_tenant_isolation ON ${t};
CREATE POLICY ${t}_tenant_isolation ON ${t}
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
`).join('\n');

// Ensure the schema exists. Idempotent (IF NOT EXISTS). A caller runs this once
// before serving (server.js awaits repo.init() before listen).
//
// Serialized with a transaction-scoped advisory lock: CREATE TABLE/INDEX
// IF NOT EXISTS still races when two processes create the same objects on an
// empty catalog (unique_violation on pg_class — a known Postgres gap in
// IF NOT EXISTS), and `node --test` runs the two Postgres test files as
// parallel processes whose init() calls collide exactly like that. The xact
// variant self-releases on COMMIT/ROLLBACK, so no unlock bookkeeping and no
// lock leaking back into the pool. The key is an arbitrary app-unique int64.
const INIT_LOCK_KEY = 727135;

async function init() {
  await tx(null, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [INIT_LOCK_KEY]);
    await c.query(SCHEMA);
    await c.query(RLS);
  });
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
// saveRecommendationRuns runs). tenant_id is scoping metadata, never payload.
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

// Fetch a round's assembled child collections (ordered) on the given tx client.
// Awaited one at a time on purpose: a single transaction client cannot run
// concurrent queries (Promise.all would; pg 9 will reject it). The client's
// transaction already carries the RLS tenant; the explicit tenant_id predicate
// is the app-layer half of the double enforcement.
async function childrenOf(c, tenant, rid) {
  const members = await c.query('SELECT id, data FROM members WHERE round_id = $1 AND tenant_id = $2 ORDER BY seq', [rid, tenant]);
  const games = await c.query('SELECT id, data FROM games WHERE round_id = $1 AND tenant_id = $2 ORDER BY seq', [rid, tenant]);
  const sessions = await c.query('SELECT id, data FROM sessions WHERE round_id = $1 AND tenant_id = $2 ORDER BY seq', [rid, tenant]);
  return { members: members.rows, games: games.rows, sessions: sessions.rows };
}

// Append an activity row (feed) on a tx client. Same {type, at, ...payload}
// shape as the JSON backend, minus the id (that's the row's own column).
async function addActivity(c, tenant, rid, type, payload) {
  const data = { type, at: new Date().toISOString(), ...payload };
  await c.query('INSERT INTO activities(id, round_id, tenant_id, data) VALUES ($1, $2, $3, $4::jsonb)', [newId(), rid, tenant, J(data)]);
}

/* ---------------------------------- Rounds --------------------------------- */

async function listRounds(tenant) {
  const rounds = await qt(tenant, 'SELECT id, name, background, recommendation_runs FROM rounds WHERE tenant_id = $1 ORDER BY seq', [tenant]);
  if (rounds.rows.length === 0) return [];
  const ids = rounds.rows.map((r) => r.id);
  const [members, games, sessions] = await Promise.all([
    qt(tenant, 'SELECT id, round_id, data FROM members WHERE round_id = ANY($1) AND tenant_id = $2 ORDER BY seq', [ids, tenant]),
    qt(tenant, 'SELECT id, round_id, data FROM games WHERE round_id = ANY($1) AND tenant_id = $2 ORDER BY seq', [ids, tenant]),
    qt(tenant, 'SELECT id, round_id, data FROM sessions WHERE round_id = ANY($1) AND tenant_id = $2 ORDER BY seq', [ids, tenant]),
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

async function getRound(tenant, rid) {
  // Fetch the round and its child collections CONCURRENTLY. Unlike childrenOf's
  // transaction callers (a single client can't run concurrent queries), getRound
  // reads via independent qt() calls, so each query gets its own connection and
  // they run in parallel — collapsing the sequential round-trips into one batch.
  // That round-trip count dominates latency to a hosted Postgres (a sequential
  // fetch measured ~1s there); listRounds already fetches this way.
  const [r, members, games, sessions] = await Promise.all([
    qt(tenant, 'SELECT id, name, background, recommendation_runs FROM rounds WHERE id = $1 AND tenant_id = $2', [rid, tenant]),
    qt(tenant, 'SELECT id, data FROM members WHERE round_id = $1 AND tenant_id = $2 ORDER BY seq', [rid, tenant]),
    qt(tenant, 'SELECT id, data FROM games WHERE round_id = $1 AND tenant_id = $2 ORDER BY seq', [rid, tenant]),
    qt(tenant, 'SELECT id, data FROM sessions WHERE round_id = $1 AND tenant_id = $2 ORDER BY seq', [rid, tenant]),
  ]);
  if (!r.rows[0]) return null;
  return assemble(r.rows[0], { members: members.rows, games: games.rows, sessions: sessions.rows });
}

async function createRound(tenant, { name, members, importFromRoundId }) {
  return tx(tenant, async (c) => {
    const rid = newId();
    await c.query('INSERT INTO rounds(id, tenant_id, name, background) VALUES ($1, $2, $3, NULL)', [rid, tenant, name]);
    for (const nm of members) {
      await c.query('INSERT INTO members(id, round_id, tenant_id, data) VALUES ($1, $2, $3, $4::jsonb)', [newId(), rid, tenant, J({ name: nm })]);
    }
    if (importFromRoundId) {
      // Active games only, copying just title/type/image (as the JSON import
      // did) — and only from a round of the same tenant.
      const src = await c.query(
        "SELECT data FROM games WHERE round_id = $1 AND tenant_id = $2 AND (data->>'retired')::boolean IS NOT TRUE ORDER BY seq",
        [importFromRoundId, tenant]
      );
      for (const row of src.rows) {
        const gid = newId();
        const data = { title: row.data.title, type: row.data.type, image: row.data.image, retired: false, retiredAt: null };
        await c.query('INSERT INTO games(id, round_id, tenant_id, data) VALUES ($1, $2, $3, $4::jsonb)', [gid, rid, tenant, J(data)]);
        await addActivity(c, tenant, rid, 'game_added', { gameId: gid, title: data.title });
      }
    }
    const round = await c.query('SELECT id, name, background, recommendation_runs FROM rounds WHERE id = $1', [rid]);
    return assemble(round.rows[0], await childrenOf(c, tenant, rid));
  });
}

async function deleteRound(tenant, rid) {
  const r = await qt(tenant, 'DELETE FROM rounds WHERE id = $1 AND tenant_id = $2', [rid, tenant]);
  return r.rowCount > 0;
}

// Bulk-insert full round objects (the shape getRound returns) PRESERVING their
// ids — the inverse of assemble(), and unlike createRound it does not mint new
// ids, so every cross-reference stays valid. Used by the one-off data.json -> DB
// migration (scripts/migrate-json-to-postgres.js), which imports the pre-tenancy
// data under tenant 'default'. One transaction for the whole import. Table names
// are static literals (no interpolation). Returns the count.
async function importRounds(tenant, rounds) {
  return tx(tenant, async (c) => {
    for (const round of rounds) {
      await c.query(
        'INSERT INTO rounds(id, tenant_id, name, background, recommendation_runs) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)',
        [
          round.id,
          tenant,
          round.name,
          round.background == null ? null : J(round.background),
          round.recommendationRuns == null ? null : J(round.recommendationRuns),
        ]
      );
      for (const m of round.members || []) {
        const { id, ...data } = m;
        await c.query('INSERT INTO members(id, round_id, tenant_id, data) VALUES ($1, $2, $3, $4::jsonb)', [id, round.id, tenant, J(data)]);
      }
      for (const g of round.games || []) {
        const { id, ...data } = g;
        await c.query('INSERT INTO games(id, round_id, tenant_id, data) VALUES ($1, $2, $3, $4::jsonb)', [id, round.id, tenant, J(data)]);
      }
      for (const s of round.sessions || []) {
        const { id, ...data } = s;
        await c.query('INSERT INTO sessions(id, round_id, tenant_id, data) VALUES ($1, $2, $3, $4::jsonb)', [id, round.id, tenant, J(data)]);
      }
      for (const a of round.activities || []) {
        const { id, ...data } = a;
        await c.query('INSERT INTO activities(id, round_id, tenant_id, data) VALUES ($1, $2, $3, $4::jsonb)', [id, round.id, tenant, J(data)]);
      }
    }
    return rounds.length;
  });
}

/* ---------------------------------- Users ----------------------------------- */
/*
 * Accounts (issue #135): users(id, data jsonb) with a unique index on the email
 * inside `data`. Deliberately global — no tenant scoping, no RLS (see the header)
 * — each user's `tenantId` lives in `data` (#136). Every key in the user object
 * is always present (null when unset), so jsonb round-trips match the JSON
 * backend exactly (absent-key parity, .claude/rules/postgres-backend.md).
 */

async function createUser(fields) {
  const uid = newId();
  try {
    await q('INSERT INTO users(id, data) VALUES ($1, $2::jsonb)', [uid, J(fields)]);
  } catch (e) {
    if (e.code === '23505') return 'email_taken'; // unique_violation on the email index
    throw e;
  }
  return { id: uid, ...fields };
}

async function getUserById(uid) {
  const r = await q('SELECT id, data FROM users WHERE id = $1', [uid]);
  return r.rows[0] ? withId(r.rows[0]) : null;
}

async function getUserByEmail(email) {
  const r = await q("SELECT id, data FROM users WHERE data->>'email' = $1", [email]);
  return r.rows[0] ? withId(r.rows[0]) : null;
}

// jsonb || replaces whole top-level keys — same semantics as the JSON backend's
// Object.assign, so token lists/identities are always passed complete.
async function updateUser(uid, patch) {
  const r = await q('UPDATE users SET data = data || $1::jsonb WHERE id = $2 RETURNING id, data', [J(patch), uid]);
  return r.rows[0] ? withId(r.rows[0]) : null;
}

async function deleteUser(uid) {
  const r = await q('DELETE FROM users WHERE id = $1', [uid]);
  return r.rowCount > 0;
}

// Bulk-insert users PRESERVING ids (the migration companion of importRounds).
async function importUsers(users) {
  return tx(null, async (c) => {
    for (const u of users) {
      const { id, ...data } = u;
      await c.query('INSERT INTO users(id, data) VALUES ($1, $2::jsonb)', [id, J(data)]);
    }
    return users.length;
  });
}

/* --------------------------------- Members --------------------------------- */

async function updateMember(tenant, rid, mid, patch) {
  const r = await qt(
    tenant,
    'UPDATE members SET data = data || $1::jsonb WHERE id = $2 AND round_id = $3 AND tenant_id = $4 RETURNING id, data',
    [J(patch), mid, rid, tenant]
  );
  return r.rows[0] ? withId(r.rows[0]) : null;
}

/* ---------------------------------- Games ---------------------------------- */

async function createGame(tenant, rid, fields) {
  return tx(tenant, async (c) => {
    const exists = await c.query('SELECT 1 FROM rounds WHERE id = $1 AND tenant_id = $2', [rid, tenant]);
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
    await c.query('INSERT INTO games(id, round_id, tenant_id, data) VALUES ($1, $2, $3, $4::jsonb)', [gid, rid, tenant, J(data)]);
    await addActivity(c, tenant, rid, 'game_added', { gameId: gid, title: data.title });
    return { id: gid, ...data };
  });
}

async function updateGame(tenant, rid, gid, patch) {
  const r = await qt(
    tenant,
    'UPDATE games SET data = data || $1::jsonb WHERE id = $2 AND round_id = $3 AND tenant_id = $4 RETURNING id, data',
    [J(patch), gid, rid, tenant]
  );
  return r.rows[0] ? withId(r.rows[0]) : null;
}

async function retireGame(tenant, rid, gid, retired) {
  return tx(tenant, async (c) => {
    const patch = { retired, retiredAt: retired ? new Date().toISOString() : null };
    const r = await c.query(
      'UPDATE games SET data = data || $1::jsonb WHERE id = $2 AND round_id = $3 AND tenant_id = $4 RETURNING id, data',
      [J(patch), gid, rid, tenant]
    );
    if (!r.rows[0]) return null;
    await addActivity(c, tenant, rid, retired ? 'game_retired' : 'game_restored', {
      gameId: gid,
      title: r.rows[0].data.title,
    });
    return withId(r.rows[0]);
  });
}

async function deleteGame(tenant, rid, gid) {
  return tx(tenant, async (c) => {
    const g = await c.query('SELECT data FROM games WHERE id = $1 AND round_id = $2 AND tenant_id = $3', [gid, rid, tenant]);
    if (!g.rows[0]) return null;
    const game = g.rows[0].data;
    if (!game.retired) return 'not_retired';

    await c.query('DELETE FROM games WHERE id = $1 AND tenant_id = $2', [gid, tenant]);

    // Scrub the game from every session of this round (same rules as the JSON
    // backend): drop it from gameIds + all votes, reset the choice if it was the
    // chosen game, and delete sessions that end up empty.
    const sessions = await c.query('SELECT id, data FROM sessions WHERE round_id = $1 AND tenant_id = $2', [rid, tenant]);
    for (const row of sessions.rows) {
      const s = row.data;
      s.gameIds = (s.gameIds || []).filter((x) => x !== gid);
      if (s.gameIds.length === 0) {
        await c.query('DELETE FROM sessions WHERE id = $1 AND tenant_id = $2', [row.id, tenant]);
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
      await c.query('UPDATE sessions SET data = $1::jsonb WHERE id = $2 AND tenant_id = $3', [J(s), row.id, tenant]);
    }

    // Drop feed entries that reference the game, then log the deletion itself.
    await c.query("DELETE FROM activities WHERE round_id = $1 AND tenant_id = $2 AND data->>'gameId' = $3", [rid, tenant, gid]);
    await addActivity(c, tenant, rid, 'game_deleted', { title: game.title });

    return { image: game.image };
  });
}

async function isImageReferenced(tenant, image) {
  const r = await qt(tenant, "SELECT 1 FROM games WHERE data->>'image' = $1 AND tenant_id = $2 LIMIT 1", [image, tenant]);
  return r.rows.length > 0;
}

/* --------------------------------- Sessions -------------------------------- */

async function createSession(tenant, rid, session) {
  return tx(tenant, async (c) => {
    const exists = await c.query('SELECT 1 FROM rounds WHERE id = $1 AND tenant_id = $2', [rid, tenant]);
    if (!exists.rows[0]) return null;
    const sid = newId();
    await c.query('INSERT INTO sessions(id, round_id, tenant_id, data) VALUES ($1, $2, $3, $4::jsonb)', [sid, rid, tenant, J(session)]);
    return { id: sid, ...session };
  });
}

// Load a session row FOR UPDATE, apply `mutate` (the same closures the JSON
// backend uses) and write it back — one atomic read-modify-write per row.
async function withSession(tenant, rid, sid, mutate) {
  return tx(tenant, async (c) => {
    const r = await c.query('SELECT data FROM sessions WHERE id = $1 AND round_id = $2 AND tenant_id = $3 FOR UPDATE', [sid, rid, tenant]);
    if (!r.rows[0]) return null;
    const data = r.rows[0].data;
    mutate(data);
    await c.query('UPDATE sessions SET data = $1::jsonb WHERE id = $2 AND tenant_id = $3', [J(data), sid, tenant]);
    return { id: sid, ...data };
  });
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
  const r = await qt(tenant, 'DELETE FROM sessions WHERE id = $1 AND round_id = $2 AND tenant_id = $3', [sid, rid, tenant]);
  return r.rowCount > 0;
}

/* -------------------------------- Activities ------------------------------- */

// The round's activity feed (insertion order, like the JSON model's array).
// Returns null when the round is missing — the feed is not part of getRound.
async function listActivities(tenant, rid) {
  const [r, acts] = await Promise.all([
    qt(tenant, 'SELECT 1 FROM rounds WHERE id = $1 AND tenant_id = $2', [rid, tenant]),
    qt(tenant, 'SELECT id, data FROM activities WHERE round_id = $1 AND tenant_id = $2 ORDER BY seq', [rid, tenant]),
  ]);
  if (!r.rows[0]) return null;
  return acts.rows.map(withId);
}

async function deleteActivity(tenant, rid, aid) {
  const r = await qt(tenant, 'DELETE FROM activities WHERE id = $1 AND round_id = $2 AND tenant_id = $3', [aid, rid, tenant]);
  return r.rowCount > 0;
}

/* -------------------------------- Background -------------------------------- */

async function setBackground(tenant, rid, bg) {
  return tx(tenant, async (c) => {
    const r = await c.query('SELECT background FROM rounds WHERE id = $1 AND tenant_id = $2', [rid, tenant]);
    if (!r.rows[0]) return null;
    const previous = r.rows[0].background ?? null;
    await c.query('UPDATE rounds SET background = $1::jsonb WHERE id = $2 AND tenant_id = $3', [J(bg), rid, tenant]);
    return { previous };
  });
}

/* ------------------------------ Recommendations ---------------------------- */

async function saveRecommendationRuns(tenant, rid, runs) {
  const r = await qt(
    tenant,
    'UPDATE rounds SET recommendation_runs = $1::jsonb WHERE id = $2 AND tenant_id = $3 RETURNING recommendation_runs',
    [J(runs), rid, tenant]
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
  createUser,
  getUserById,
  getUserByEmail,
  updateUser,
  deleteUser,
  importUsers,
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
