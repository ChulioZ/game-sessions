'use strict';

/*
 * Data-access layer — PostgreSQL backend (issue #127; Knex since #211).
 *
 * Selected by ./index.js when DATABASE_URL is set. Implements the exact same
 * async contract as ./json.js (the documented shape lives there), so routes are
 * unchanged whichever backend runs. This is the stateless-app-tier persistence
 * the production roadmap needs (docs/production-readiness.md §3).
 *
 * Query building + schema migrations go through **Knex** (issue #211): the
 * fluent builder replaces the hand-written parameterized SQL (and its JSONB
 * footguns), and versioned migration files under ./migrations replace the old
 * inline `CREATE TABLE IF NOT EXISTS` template re-run on every boot. The knex
 * instance is built from the shared ../../knexfile.js (same config the CLI uses).
 *
 * Storage shape — a table per top-level entity, one row each, with the "messy"
 * nested bits kept as JSONB (votes maps, gameIds/winnerIds arrays, activity
 * payloads, the design) exactly as the roadmap sanctions ("JSONB where that's
 * genuinely simpler, need not fully normalize on day one"):
 *   rounds(id, tenant_id, name, background jsonb, tags jsonb)
 *   members / games / sessions / activities (id, round_id -> rounds ON DELETE
 *   CASCADE, tenant_id, data jsonb)  — `data` holds every field except
 *   id/round_id.
 * `seq bigserial` preserves insertion order (arrays in the JSON model are
 * ordered).
 *
 * Tenancy (issue #136) — two independent layers, so a slip in one can't leak:
 *  1. App layer: every round-scoped method takes the tenant first and every
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
 *  - Every value written to a JSONB column is passed through `J` (JSON.stringify),
 *    NOT as a raw JS value. Knex/pg serialize a plain object to JSON fine but turn
 *    a JS ARRAY into a Postgres array literal — corrupting `tags` (an array) and
 *    any array payload. Stringifying uniformly sidesteps the footgun; pg casts
 *    the text to jsonb on assignment.
 *  - JSONB reads come back already parsed (pg's jsonb parser -> JS objects).
 *  - Not-found -> `null`; never throws for it. SQL/connection errors do reject
 *    and reach the central error handler (Express 5 forwards them).
 */

const crypto = require('crypto');
const knex = require('knex')(require('../../knexfile'));

const newId = () => crypto.randomBytes(8).toString('hex');
const J = (v) => JSON.stringify(v);

// Run fn inside a transaction (Knex BEGIN/COMMIT, ROLLBACK on throw). When
// `tenant` is non-null, the transaction sets the RLS scope `app.tenant_id` with
// set_config(..., true): it dies with the transaction, so no tenant ever leaks
// to the next pooled checkout. `fn` receives the Knex transaction object (used
// as a query builder). An early `return` with no writes commits an empty tx.
function tx(tenant, fn) {
  return knex.transaction(async (trx) => {
    if (tenant != null) {
      await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [String(tenant)]);
    }
    return fn(trx);
  });
}

// One tenant-scoped statement in its own little transaction (the RLS setting
// only exists inside one — see tx). `fn(trx)` returns the builder to await.
// Each call costs BEGIN/SET/<stmt>/COMMIT = 4 round trips on its own pooled
// connection — acceptable on the write paths that use it, but exactly the
// amplification that made the hot reads slow against a hosted Postgres (#203);
// reads go through the single-round-trip READ_SQL statements below instead.
const qt = (tenant, fn) => tx(tenant, fn);

// A jsonb `data || <patch>` merge fragment — replaces whole top-level keys, the
// same semantics as the JSON backend's Object.assign. `knex.raw` keeps `?::jsonb`
// as a literal cast around the positional binding.
const mergeData = (patch) => knex.raw('data || ?::jsonb', [J(patch)]);

// Serialize concurrent boots (rolling deploys, parallel test processes) with a
// transaction-scoped advisory lock, then run pending migrations. Knex's own
// migration lock guards RUNNING migrations but NOT the first CREATE of its
// bookkeeping tables (knex_migrations / _lock) on an empty catalog — the same
// pg_class race the raw backend hit with CREATE TABLE IF NOT EXISTS (a known
// Postgres gap). Proven: without this lock, two simultaneous first-boots crash
// with a duplicate knex_migrations table; with it, they serialize cleanly. The
// lock-holding transaction stays open while migrate.latest() runs on OTHER
// pooled connections, so a second booter blocks on the advisory lock until the
// first has finished migrating. The xact variant self-releases at COMMIT.
const INIT_LOCK_KEY = 727135;

async function init() {
  await knex.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [INIT_LOCK_KEY]);
    await knex.migrate.latest();
  });
}

async function end() {
  await knex.destroy();
}

// Re-attach the id column and merge the JSONB `data` back into one flat object,
// reproducing the JSON model's entity shape ({ id, ...fields }).
const withId = (row) => ({ id: row.id, ...row.data });

// Assemble the nested round object from its row + child rows, in the same key
// order the JSON backend builds. The activity feed is NOT part of it (issue
// #197 — it is unbounded and only Chronik reads it, via listActivities()).
// background is always present (may be null); tags and lastSessionFilters only
// when they have ever been written (matches the JSON model, where those keys are
// absent until addTag / the first draw-flow session runs). tenant_id is scoping
// metadata, never payload.
function assemble(round, children) {
  const out = {
    id: round.id,
    name: round.name,
    members: children.members.map(withId),
    games: children.games.map(withId),
    sessions: children.sessions.map(withId),
    background: round.background ?? null,
  };
  if (round.tags != null) out.tags = round.tags;
  if (round.lastSessionFilters != null) out.lastSessionFilters = round.lastSessionFilters;
  return out;
}

/*
 * Single-round-trip read statements (issue #203). The hot reads (home screen,
 * round navigation, Chronik) used to issue one qt() PER TABLE — each a full
 * transaction: BEGIN + set_config + SELECT + COMMIT = 4 round trips on its own
 * pooled connection. Measured against a latency-injected Postgres, that put
 * ~9 round trips of wall time under GET /api/rounds and ~4.4 under
 * GET /api/rounds/:rid — the ~1s hosted round loads #203 was filed for.
 *
 * These statements collapse each read to ONE round trip on ONE connection:
 *
 *  - The materialized CTE `_t` calls set_config('app.tenant_id', ?, true),
 *    establishing the RLS tenant scope *inside the statement's own implicit
 *    transaction*; being transaction-local it dies at statement end, so nothing
 *    ever leaks to the next pooled checkout (same guarantee tx() gives).
 *  - Every subquery correlates on `_t.v` — set_config's RETURN VALUE (the
 *    tenant id). That is a real dataflow dependency, not an ordering hope: the
 *    executor must produce the `_t` row (running set_config) before it can
 *    evaluate any target-list subquery, so the RLS policies' current_setting()
 *    always sees the tenant during the scans. MATERIALIZED (plus set_config
 *    being volatile) keeps the CTE a separate, evaluate-first node.
 *  - The explicit `tenant_id = _t.v` predicates stay the app-layer half of the
 *    double enforcement (.claude/rules/tenancy-rls.md); RLS remains the
 *    backstop. If the evaluation-order guarantee ever broke, RLS would return
 *    ZERO rows (fail-closed, loud) — never cross-tenant data. The plain-role
 *    probe in test/repo.postgres.test.js runs these texts under FORCE RLS as a
 *    non-superuser to prove the ordering holds for real.
 *
 * Exported for exactly that test; don't rewrite these reads back onto qt() —
 * that reintroduces the round-trip amplification this fixed.
 */
// jsonb_agg of {id[, round_id], data} entity rows, insertion-ordered, [] when none.
const AGG = "coalesce(jsonb_agg(jsonb_build_object('id', id, 'data', data) ORDER BY seq), '[]'::jsonb)";
const AGG_RID = "coalesce(jsonb_agg(jsonb_build_object('id', id, 'round_id', round_id, 'data', data) ORDER BY seq), '[]'::jsonb)";
const ROUND_OBJ = "jsonb_build_object('id', id, 'name', name, 'background', background, 'tags', tags, 'lastSessionFilters', last_session_filters)";
const READ_SQL = {
  // bindings: [tenant]
  list: `
WITH _t AS MATERIALIZED (SELECT set_config('app.tenant_id', ?, true) AS v)
SELECT
  (SELECT coalesce(jsonb_agg(${ROUND_OBJ} ORDER BY seq), '[]'::jsonb)
     FROM rounds WHERE tenant_id = _t.v) AS rounds,
  (SELECT ${AGG_RID} FROM members  WHERE tenant_id = _t.v) AS members,
  (SELECT ${AGG_RID} FROM games    WHERE tenant_id = _t.v) AS games,
  (SELECT ${AGG_RID} FROM sessions WHERE tenant_id = _t.v) AS sessions
FROM _t`,
  // bindings: [tenant, rid, rid, rid, rid]
  round: `
WITH _t AS MATERIALIZED (SELECT set_config('app.tenant_id', ?, true) AS v)
SELECT
  (SELECT ${ROUND_OBJ} FROM rounds WHERE id = ? AND tenant_id = _t.v) AS round,
  (SELECT ${AGG} FROM members  WHERE round_id = ? AND tenant_id = _t.v) AS members,
  (SELECT ${AGG} FROM games    WHERE round_id = ? AND tenant_id = _t.v) AS games,
  (SELECT ${AGG} FROM sessions WHERE round_id = ? AND tenant_id = _t.v) AS sessions
FROM _t`,
  // bindings: [tenant, rid, rid]
  activities: `
WITH _t AS MATERIALIZED (SELECT set_config('app.tenant_id', ?, true) AS v)
SELECT
  (SELECT jsonb_build_object('id', id) FROM rounds WHERE id = ? AND tenant_id = _t.v) AS round,
  (SELECT ${AGG} FROM activities WHERE round_id = ? AND tenant_id = _t.v) AS acts
FROM _t`,
};

// Fetch a round's assembled child collections (ordered) on the given tx client.
// Awaited one at a time on purpose: a single transaction runs on ONE connection,
// which cannot run concurrent queries. The transaction already carries the RLS
// tenant; the explicit tenant_id predicate is the app-layer half of the double
// enforcement. (Write flows only — the hot reads use READ_SQL above.)
async function childrenOf(trx, tenant, rid) {
  const members = await trx('members').where({ round_id: rid, tenant_id: tenant }).orderBy('seq').select('id', 'data');
  const games = await trx('games').where({ round_id: rid, tenant_id: tenant }).orderBy('seq').select('id', 'data');
  const sessions = await trx('sessions').where({ round_id: rid, tenant_id: tenant }).orderBy('seq').select('id', 'data');
  return { members, games, sessions };
}

// Append an activity row (feed) on a tx client. Same {type, at, ...payload}
// shape as the JSON backend, minus the id (that's the row's own column).
async function addActivity(trx, tenant, rid, type, payload) {
  const data = { type, at: new Date().toISOString(), ...payload };
  await trx('activities').insert({ id: newId(), round_id: rid, tenant_id: tenant, data: J(data) });
}

/* ---------------------------------- Rounds --------------------------------- */

async function listRounds(tenant) {
  // One round trip for the whole tenant (READ_SQL rationale above): rounds plus
  // ALL child rows, grouped per round in JS. The global ORDER BY seq preserves
  // each round's insertion order through the stable grouping.
  const { rows } = await knex.raw(READ_SQL.list, [tenant]);
  const { rounds, members, games, sessions } = rows[0];
  const group = (entityRows) => {
    const m = new Map();
    for (const row of entityRows) {
      if (!m.has(row.round_id)) m.set(row.round_id, []);
      m.get(row.round_id).push(row);
    }
    return m;
  };
  const mm = group(members), mg = group(games), ms = group(sessions);
  return rounds.map((r) =>
    assemble(r, {
      members: mm.get(r.id) || [],
      games: mg.get(r.id) || [],
      sessions: ms.get(r.id) || [],
    })
  );
}

async function getRound(tenant, rid) {
  // One round trip for the round + its three child collections (READ_SQL above).
  const { rows } = await knex.raw(READ_SQL.round, [tenant, rid, rid, rid, rid]);
  const { round, members, games, sessions } = rows[0];
  if (!round) return null;
  return assemble(round, { members, games, sessions });
}

async function createRound(tenant, { name, members, importFromRoundId }) {
  return tx(tenant, async (trx) => {
    const rid = newId();
    await trx('rounds').insert({ id: rid, tenant_id: tenant, name, background: null });
    for (const nm of members) {
      await trx('members').insert({ id: newId(), round_id: rid, tenant_id: tenant, data: J({ name: nm }) });
    }
    if (importFromRoundId) {
      // Active games only, copying just title/image — and only from a round of
      // the same tenant.
      const src = await trx('games')
        .where({ round_id: importFromRoundId, tenant_id: tenant })
        .whereRaw("(data->>'retired')::boolean IS NOT TRUE")
        .orderBy('seq')
        .select('data');
      for (const row of src) {
        const gid = newId();
        const data = { title: row.data.title, image: row.data.image, retired: false, retiredAt: null };
        await trx('games').insert({ id: gid, round_id: rid, tenant_id: tenant, data: J(data) });
        await addActivity(trx, tenant, rid, 'game_added', { gameId: gid, title: data.title });
      }
    }
    // Aliased so assemble() sees the same camelCase key ROUND_OBJ builds.
    const round = await trx('rounds')
      .where({ id: rid })
      .select('id', 'name', 'background', 'tags', 'last_session_filters as lastSessionFilters');
    return assemble(round[0], await childrenOf(trx, tenant, rid));
  });
}

async function deleteRound(tenant, rid) {
  const n = await qt(tenant, (trx) => trx('rounds').where({ id: rid, tenant_id: tenant }).del());
  return n > 0;
}

/* ---------------------------------- Users ----------------------------------- */
/*
 * Accounts (issue #135): users(id, data jsonb) with a unique index on the email
 * inside `data`. Deliberately global — no tenant scoping, no RLS (see the header)
 * — each user's `tenantId` lives in `data` (#136). Every key in the user object
 * is always present (null when unset), so jsonb round-trips match the JSON
 * backend exactly (absent-key parity, .claude/rules/postgres-backend.md). These
 * methods use the base knex instance (no tenant transaction) since users aren't
 * RLS-scoped.
 */

async function createUser(fields) {
  const uid = newId();
  try {
    await knex('users').insert({ id: uid, data: J(fields) });
  } catch (e) {
    if (e.code === '23505') return 'email_taken'; // unique_violation on the email index
    throw e;
  }
  return { id: uid, ...fields };
}

async function getUserById(uid) {
  const rows = await knex('users').where({ id: uid }).select('id', 'data');
  return rows[0] ? withId(rows[0]) : null;
}

async function getUserByEmail(email) {
  const rows = await knex('users').whereRaw("data->>'email' = ?", [email]).select('id', 'data');
  return rows[0] ? withId(rows[0]) : null;
}

// jsonb || replaces whole top-level keys — same semantics as the JSON backend's
// Object.assign, so token lists/identities are always passed complete.
async function updateUser(uid, patch) {
  const rows = await knex('users').where({ id: uid }).update({ data: mergeData(patch) }).returning(['id', 'data']);
  return rows[0] ? withId(rows[0]) : null;
}

async function deleteUser(uid) {
  const n = await knex('users').where({ id: uid }).del();
  return n > 0;
}

// Every user, for the operator's account list (#268). The ROUTE strips secrets
// before responding — the repo returns the stored shape, as it does everywhere.
async function listUsers() {
  const rows = await knex('users').orderBy('seq', 'asc').select('id', 'data');
  return rows.map(withId);
}

/* -------------------------------- Moderation -------------------------------- */
/*
 * Operator tooling (#268) — the only GLOBAL (cross-tenant) round-data access in
 * this backend, because an abuse notice names an image, not a tenant. Not in
 * TENANT_METHODS; routes reach these on the module-level repo, never req.repo.
 *
 * `atx` is the read-only admin escape: a transaction that sets `app.admin='on'`,
 * which a separate FOR SELECT RLS policy admits (migration
 * 20260720140000_moderation.js). So a lookup can see across tenants while a
 * WRITE still cannot — the tenant policy is untouched and is the only one
 * consulted for INSERT/UPDATE/DELETE. That split is deliberate and structural:
 * `OR`-ing the flag into the existing FOR ALL policy's USING clause would have
 * opened cross-tenant DELETE, which has no WITH CHECK to hold it back. The
 * setting is transaction-local (set_config(..., true)), so it dies at COMMIT and
 * never reaches the next pooled checkout, exactly like app.tenant_id.
 *
 * Consequently takedownImage does NOT write under the escape: it resolves the
 * owning tenant with a read, then performs the update through the ordinary
 * tenant-scoped tx(tenant, ...) path.
 */
function atx(fn) {
  return knex.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.admin', 'on', true)", []);
    return fn(trx);
  });
}

async function findImageOwner(image) {
  const rows = await atx((trx) =>
    trx('games')
      .join('rounds', 'rounds.id', 'games.round_id')
      .whereRaw("games.data->>'image' = ?", [image])
      .select(
        'games.id as gameId',
        'games.tenant_id as tenantId',
        'games.data as gameData',
        'rounds.id as roundId',
        'rounds.name as roundName',
      )
      .first());
  if (!rows) return null;
  return {
    image,
    tenantId: rows.tenantId,
    roundId: rows.roundId,
    roundName: rows.roundName,
    gameId: rows.gameId,
    gameTitle: rows.gameData.title,
  };
}

// Clear the cover from every game referencing this path, across all tenants.
// Returns the count of games changed. The per-tenant loop is what keeps the
// write inside normal tenant isolation (see the atx note above): the escape
// finds the rows, the tenant-scoped transaction changes them.
async function takedownImage(image) {
  const targets = await atx((trx) =>
    trx('games').whereRaw("data->>'image' = ?", [image]).select('id', 'tenant_id'));
  let cleared = 0;
  for (const t of targets) {
    const rows = await qt(t.tenant_id, (trx) =>
      trx('games')
        .where({ id: t.id, tenant_id: t.tenant_id })
        .update({ data: mergeData({ image: null }) })
        .returning('id'));
    if (rows[0]) cleared += 1;
  }
  return cleared;
}

// Global, un-scoped, no RLS — operator data ABOUT tenants (like `users`).
async function logModeration(entry) {
  const eid = newId();
  await knex('moderation_log').insert({ id: eid, data: J(entry) });
  return { id: eid, ...entry };
}

async function listModeration(limit = 100) {
  const rows = await knex('moderation_log').orderBy('seq', 'desc').limit(limit).select('id', 'data');
  return rows.map(withId);
}

/* --------------------------------- Members --------------------------------- */

async function updateMember(tenant, rid, mid, patch) {
  const rows = await qt(tenant, (trx) =>
    trx('members').where({ id: mid, round_id: rid, tenant_id: tenant }).update({ data: mergeData(patch) }).returning(['id', 'data']));
  return rows[0] ? withId(rows[0]) : null;
}

/* ---------------------------------- Games ---------------------------------- */

async function createGame(tenant, rid, fields) {
  return tx(tenant, async (trx) => {
    const round = await trx('rounds').where({ id: rid, tenant_id: tenant }).first('id');
    if (!round) return null;
    const gid = newId();
    const data = {
      title: fields.title,
      minPlayers: fields.minPlayers,
      maxPlayers: fields.maxPlayers,
      image: fields.image,
      retired: false,
      retiredAt: null,
    };
    if (fields.source) data.source = fields.source;
    if (Array.isArray(fields.tagIds) && fields.tagIds.length) data.tagIds = fields.tagIds;
    await trx('games').insert({ id: gid, round_id: rid, tenant_id: tenant, data: J(data) });
    await addActivity(trx, tenant, rid, 'game_added', { gameId: gid, title: data.title });
    return { id: gid, ...data };
  });
}

async function updateGame(tenant, rid, gid, patch) {
  const rows = await qt(tenant, (trx) =>
    trx('games').where({ id: gid, round_id: rid, tenant_id: tenant }).update({ data: mergeData(patch) }).returning(['id', 'data']));
  return rows[0] ? withId(rows[0]) : null;
}

async function retireGame(tenant, rid, gid, retired) {
  return tx(tenant, async (trx) => {
    const patch = { retired, retiredAt: retired ? new Date().toISOString() : null };
    const rows = await trx('games').where({ id: gid, round_id: rid, tenant_id: tenant }).update({ data: mergeData(patch) }).returning(['id', 'data']);
    if (!rows[0]) return null;
    await addActivity(trx, tenant, rid, retired ? 'game_retired' : 'game_restored', {
      gameId: gid,
      title: rows[0].data.title,
    });
    return withId(rows[0]);
  });
}

async function deleteGame(tenant, rid, gid) {
  return tx(tenant, async (trx) => {
    const g = await trx('games').where({ id: gid, round_id: rid, tenant_id: tenant }).first('data');
    if (!g) return null;
    const game = g.data;
    if (!game.retired) return 'not_retired';

    await trx('games').where({ id: gid, tenant_id: tenant }).del();

    // Scrub the game from every session of this round (same rules as the JSON
    // backend): drop it from gameIds + all votes, reset the choice if it was the
    // chosen game, and delete sessions that end up empty.
    const sessions = await trx('sessions').where({ round_id: rid, tenant_id: tenant }).select('id', 'data');
    for (const row of sessions) {
      const s = row.data;
      s.gameIds = (s.gameIds || []).filter((x) => x !== gid);
      if (s.gameIds.length === 0) {
        await trx('sessions').where({ id: row.id, tenant_id: tenant }).del();
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
      await trx('sessions').where({ id: row.id, tenant_id: tenant }).update({ data: J(s) });
    }

    // Drop feed entries that reference the game, then log the deletion itself.
    await trx('activities').where({ round_id: rid, tenant_id: tenant }).whereRaw("data->>'gameId' = ?", [gid]).del();
    await addActivity(trx, tenant, rid, 'game_deleted', { title: game.title });

    return { image: game.image };
  });
}

async function isImageReferenced(tenant, image) {
  const row = await qt(tenant, (trx) =>
    trx('games').whereRaw("data->>'image' = ?", [image]).andWhere({ tenant_id: tenant }).first(knex.raw('1')));
  return !!row;
}

/* --------------------------------- Sessions -------------------------------- */

// `filters` ({ tagIds, excludeTagIds, count }) is the draw-flow's remembered
// session-start preset (#252), written onto the round in the SAME transaction
// as the session insert. Direct-pick sessions pass nothing, so they never read
// or overwrite the preset.
async function createSession(tenant, rid, session, filters) {
  return tx(tenant, async (trx) => {
    const round = await trx('rounds').where({ id: rid, tenant_id: tenant }).first('id');
    if (!round) return null;
    const sid = newId();
    await trx('sessions').insert({ id: sid, round_id: rid, tenant_id: tenant, data: J(session) });
    if (filters) {
      await trx('rounds')
        .where({ id: rid, tenant_id: tenant })
        .update({ last_session_filters: J(filters) });
    }
    return { id: sid, ...session };
  });
}

// Load a session row FOR UPDATE, apply `mutate` (the same closures the JSON
// backend uses) and write it back — one atomic read-modify-write per row.
async function withSession(tenant, rid, sid, mutate) {
  return tx(tenant, async (trx) => {
    const row = await trx('sessions').where({ id: sid, round_id: rid, tenant_id: tenant }).forUpdate().first('data');
    if (!row) return null;
    const data = row.data;
    mutate(data);
    await trx('sessions').where({ id: sid, tenant_id: tenant }).update({ data: J(data) });
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
  const n = await qt(tenant, (trx) => trx('sessions').where({ id: sid, round_id: rid, tenant_id: tenant }).del());
  return n > 0;
}

/* -------------------------------- Activities ------------------------------- */

// The round's activity feed (insertion order, like the JSON model's array).
// Returns null when the round is missing — the feed is not part of getRound.
async function listActivities(tenant, rid) {
  // One round trip: round-existence probe + the feed (READ_SQL rationale above).
  const { rows } = await knex.raw(READ_SQL.activities, [tenant, rid, rid]);
  if (!rows[0].round) return null;
  return rows[0].acts.map(withId);
}

async function deleteActivity(tenant, rid, aid) {
  const n = await qt(tenant, (trx) => trx('activities').where({ id: aid, round_id: rid, tenant_id: tenant }).del());
  return n > 0;
}

/* -------------------------------- Background -------------------------------- */

async function setBackground(tenant, rid, bg) {
  return tx(tenant, async (trx) => {
    const row = await trx('rounds').where({ id: rid, tenant_id: tenant }).first('background');
    if (!row) return null;
    const previous = row.background ?? null;
    await trx('rounds').where({ id: rid, tenant_id: tenant }).update({ background: J(bg) });
    return { previous };
  });
}

/* ----------------------------------- Tags ----------------------------------- */

// Create a round-level tag (#238), reusing an existing one whose name matches
// (the route trims; compared case-insensitively). Returns the tag, or null if
// the round is gone. FOR UPDATE serializes concurrent creates so two same-name
// tags can't race past the dedupe. `tags` is an ARRAY — J() it (see header).
async function addTag(tenant, rid, name) {
  return tx(tenant, async (trx) => {
    const row = await trx('rounds').where({ id: rid, tenant_id: tenant }).forUpdate().first('tags');
    if (!row) return null;
    const tags = row.tags || [];
    const existing = tags.find((tg) => tg.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const tag = { id: newId(), name };
    tags.push(tag);
    await trx('rounds').where({ id: rid, tenant_id: tenant }).update({ tags: J(tags) });
    return tag;
  });
}

// Delete a round tag and silently unassign it from every game that had it.
// Returns true/false (found) — a missing round reads like a missing tag.
async function deleteTag(tenant, rid, tagId) {
  return tx(tenant, async (trx) => {
    const row = await trx('rounds').where({ id: rid, tenant_id: tenant }).forUpdate().first('tags');
    if (!row) return false;
    const tags = row.tags || [];
    const idx = tags.findIndex((tg) => tg.id === tagId);
    if (idx === -1) return false;
    tags.splice(idx, 1);
    await trx('rounds').where({ id: rid, tenant_id: tenant }).update({ tags: J(tags) });
    const games = await trx('games').where({ round_id: rid, tenant_id: tenant }).select('id', 'data');
    for (const g of games) {
      if (Array.isArray(g.data.tagIds) && g.data.tagIds.includes(tagId)) {
        const tagIds = g.data.tagIds.filter((x) => x !== tagId);
        await trx('games').where({ id: g.id, tenant_id: tenant }).update({ data: mergeData({ tagIds }) });
      }
    }
    return true;
  });
}

module.exports = {
  READ_SQL, // for the plain-role RLS ordering probe in test/repo.postgres.test.js
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
