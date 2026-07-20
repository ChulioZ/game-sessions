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

// Which schema version this process is actually running against — the operator
// panel's answer to "did this deploy migrate?" (#274). `pending > 0` means the
// code shipped but the schema did not, which otherwise only surfaces later as a
// column-not-found error under real traffic.
//
// Deliberately NOT tenant-scoped and absent from TENANT_METHODS: the migration
// state is a property of the database, not of any tenant's data, and knex's
// bookkeeping table sits outside RLS entirely.
async function migrationStatus() {
  const [completed, pending] = await knex.migrate.list();
  const names = completed.map((m) => (typeof m === 'string' ? m : m.name));
  return {
    backend: 'postgres',
    latest: names.length ? names[names.length - 1] : null,
    pending: pending.length,
  };
}

// Re-attach the id column and merge the JSONB `data` back into one flat object,
// reproducing the JSON model's entity shape ({ id, ...fields }).
const withId = (row) => ({ id: row.id, ...row.data });

// Row count of an un-scoped global table (moderation_log, feedback — #288).
// Postgres count() is a bigint, which pg hands back as a STRING to avoid losing
// precision past 2^53 — returning it raw would make the JSON backend (a real
// number) and this one disagree, which the contract suite compares strictly.
const count = async (table) => Number((await knex(table).count('* as n').first()).n);

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
  if (round.providers != null) out.providers = round.providers;
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
const ROUND_OBJ = "jsonb_build_object('id', id, 'name', name, 'background', background, 'tags', tags, 'providers', providers, 'lastSessionFilters', last_session_filters)";
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
  // bindings: [tenant]. The home-screen summary, computed entirely in the
  // database: counts + the "last played" highlight per round, WITHOUT shipping
  // every game/session row to the app. listRounds moves the tenant's whole
  // dataset (~80 KB for one real group today, megabytes at quota scale) to
  // answer with under a kilobyte — over a non-local DB link the transfer alone
  // dominated the request (the #294-era ~600 ms home loads). This statement
  // keeps the one-round-trip property AND makes the bytes proportional to the
  // response. lastPlayed mirrors routes/rounds.js's old JS exactly: newest
  // finished session (by createdAt, seq as the stable tiebreak) whose chosen
  // game still exists; winnerNames keep winnerIds order and drop unknown ids.
  // jsonb_exists(), never the jsonb `?` operator: `?` is the positional
  // binding character for knex (and pg's $-rewriting test probe), so the
  // operator form cannot appear in any SQL text the repo executes.
  summaries: `
WITH _t AS MATERIALIZED (SELECT set_config('app.tenant_id', ?, true) AS v)
SELECT coalesce(jsonb_agg(x.s ORDER BY x.seq), '[]'::jsonb) AS summaries
FROM _t, LATERAL (
  SELECT r.seq, jsonb_build_object(
    'id', r.id,
    'name', r.name,
    'members', (
      SELECT coalesce(jsonb_agg(
        jsonb_build_object('id', m.id, 'name', m.data->'name')
          || (CASE WHEN jsonb_exists(m.data, 'color')
                THEN jsonb_build_object('color', m.data->'color') ELSE '{}'::jsonb END)
        ORDER BY m.seq), '[]'::jsonb)
      FROM members m WHERE m.round_id = r.id AND m.tenant_id = _t.v),
    'memberCount', (SELECT count(*) FROM members m WHERE m.round_id = r.id AND m.tenant_id = _t.v),
    'gameCount', (SELECT count(*) FROM games g WHERE g.round_id = r.id AND g.tenant_id = _t.v
      AND (g.data->>'retired')::boolean IS NOT TRUE
      AND (g.data->>'completed')::boolean IS NOT TRUE),
    'sessionCount', (SELECT count(*) FROM sessions s WHERE s.round_id = r.id AND s.tenant_id = _t.v),
    'playedCount', (SELECT count(*) FROM sessions s WHERE s.round_id = r.id AND s.tenant_id = _t.v
      AND (s.data->>'finished')::boolean IS TRUE),
    'background', r.background,
    'lastPlayed', (
      SELECT jsonb_build_object(
        'gameTitle', g.data->'title',
        'winnerNames', (
          SELECT coalesce(jsonb_agg(mw.data->>'name' ORDER BY w.ord), '[]'::jsonb)
          FROM jsonb_array_elements_text(coalesce(s.data->'winnerIds', '[]'::jsonb))
            WITH ORDINALITY AS w(wid, ord)
          JOIN members mw ON mw.id = w.wid AND mw.round_id = r.id AND mw.tenant_id = _t.v),
        'at', s.data->'createdAt')
      FROM sessions s
      JOIN games g ON g.id = s.data->>'chosenGameId' AND g.round_id = r.id AND g.tenant_id = _t.v
      WHERE s.round_id = r.id AND s.tenant_id = _t.v
        AND (s.data->>'finished')::boolean IS TRUE
      ORDER BY s.data->>'createdAt' DESC, s.seq ASC
      LIMIT 1)
  ) AS s
  FROM rounds r WHERE r.tenant_id = _t.v
) x`,
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
  // bindings: [tenant, rid, rid]. The light validation read: the round row +
  // its members (a handful of tiny rows), WITHOUT the games/sessions payload.
  // Mutation routes fetch the round only to 404 and to validate against
  // tags/providers/members — pulling every game and vote map out of the
  // database for that made each WRITE as expensive as the biggest read.
  meta: `
WITH _t AS MATERIALIZED (SELECT set_config('app.tenant_id', ?, true) AS v)
SELECT
  (SELECT ${ROUND_OBJ} FROM rounds WHERE id = ? AND tenant_id = _t.v) AS round,
  (SELECT ${AGG} FROM members WHERE round_id = ? AND tenant_id = _t.v) AS members
FROM _t`,
  // bindings: [tenant, sid, rid] / [tenant, gid, rid] — one child entity row.
  session: `
WITH _t AS MATERIALIZED (SELECT set_config('app.tenant_id', ?, true) AS v)
SELECT (SELECT jsonb_build_object('id', id, 'data', data) FROM sessions
  WHERE id = ? AND round_id = ? AND tenant_id = _t.v) AS entity
FROM _t`,
  game: `
WITH _t AS MATERIALIZED (SELECT set_config('app.tenant_id', ?, true) AS v)
SELECT (SELECT jsonb_build_object('id', id, 'data', data) FROM games
  WHERE id = ? AND round_id = ? AND tenant_id = _t.v) AS entity
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

// The home-screen summary rows (see READ_SQL.summaries for why this exists and
// what it computes). One round trip, bytes proportional to the response.
async function listRoundSummaries(tenant) {
  const { rows } = await knex.raw(READ_SQL.summaries, [tenant]);
  return rows[0].summaries;
}

async function getRound(tenant, rid) {
  // One round trip for the round + its three child collections (READ_SQL above).
  const { rows } = await knex.raw(READ_SQL.round, [tenant, rid, rid, rid, rid]);
  const { round, members, games, sessions } = rows[0];
  if (!round) return null;
  return assemble(round, { members, games, sessions });
}

// The light validation read (READ_SQL.meta): everything getRound carries except
// the games/sessions collections. Same key semantics as assemble — background
// always present, tags/providers/lastSessionFilters only when ever written.
async function getRoundMeta(tenant, rid) {
  const { rows } = await knex.raw(READ_SQL.meta, [tenant, rid, rid]);
  const { round, members } = rows[0];
  if (!round) return null;
  const out = {
    id: round.id,
    name: round.name,
    members: members.map(withId),
    background: round.background ?? null,
  };
  if (round.tags != null) out.tags = round.tags;
  if (round.providers != null) out.providers = round.providers;
  if (round.lastSessionFilters != null) out.lastSessionFilters = round.lastSessionFilters;
  return out;
}

// One session / one game by id, without assembling the whole round (the write
// routes validate against a single entity). Wrong round or tenant reads as
// not-found, like everywhere else.
async function getSession(tenant, rid, sid) {
  const { rows } = await knex.raw(READ_SQL.session, [tenant, sid, rid]);
  return rows[0].entity ? withId(rows[0].entity) : null;
}

async function getGame(tenant, rid, gid) {
  const { rows } = await knex.raw(READ_SQL.game, [tenant, gid, rid]);
  return rows[0].entity ? withId(rows[0].entity) : null;
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
        .whereRaw("(data->>'completed')::boolean IS NOT TRUE")
        .orderBy('seq')
        .select('data');
      for (const row of src) {
        const gid = newId();
        const data = {
          title: row.data.title,
          image: row.data.image,
          retired: false,
          retiredAt: null,
          completed: false,
          completedAt: null,
        };
        await trx('games').insert({ id: gid, round_id: rid, tenant_id: tenant, data: J(data) });
        await addActivity(trx, tenant, rid, 'game_added', { gameId: gid, title: data.title });
      }
    }
    // Aliased so assemble() sees the same camelCase key ROUND_OBJ builds.
    const round = await trx('rounds')
      .where({ id: rid })
      .select('id', 'name', 'background', 'tags', 'providers', 'last_session_filters as lastSessionFilters');
    return assemble(round[0], await childrenOf(trx, tenant, rid));
  });
}

// See the JSON backend for the contract and why the images must be collected
// before the delete (#280). Children go with the round via ON DELETE CASCADE,
// which is exactly why their cover paths are unrecoverable afterwards.
// Sequential awaits: one transaction runs on one connection (see
// .claude/rules/postgres-backend.md).
async function deleteRound(tenant, rid) {
  return tx(tenant, async (trx) => {
    const round = await trx('rounds')
      .where({ id: rid, tenant_id: tenant })
      .first('id', 'background');
    if (!round) return null;

    const games = await trx('games')
      .where({ round_id: rid, tenant_id: tenant })
      .whereRaw("data->>'image' IS NOT NULL")
      .select('data');

    const images = new Set();
    for (const g of games) images.add(g.data.image);
    if (round.background && round.background.type === 'collage' && round.background.image) {
      images.add(round.background.image);
    }

    await trx('rounds').where({ id: rid, tenant_id: tenant }).del();
    return { images: [...images] };
  });
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

/* --------------------------- Erasure & export (#273) ------------------------ */
/*
 * Art. 17 (erasure) and Art. 15/20 (access/portability), operator-side. Global
 * like the rest of this section — the operator names an ACCOUNT, and the account
 * carries the tenant id.
 *
 * Note both run through the ORDINARY tenant-scoped tx(tenant, ...) path, NOT the
 * atx admin escape: resolving the account already yields its tenant, so the work
 * is single-tenant and needs no cross-tenant widening at all. For the erasure
 * that is not merely tidier but required — the admin policy is FOR SELECT only,
 * so a DELETE under it matches zero rows by design (see the atx note above).
 */

// Everything held for one tenant, for an access request. Unlike getRound this
// DOES include the activity feed: "everything you hold about me" has to mean
// everything, and the feed is held data (assemble() omits it only because it is
// unbounded and no view needs it — #197).
async function exportTenant(tenant) {
  if (!tenant) return { tenantId: null, rounds: [] };
  return tx(tenant, async (trx) => {
    const rows = await trx('rounds')
      .where({ tenant_id: tenant })
      .orderBy('seq')
      .select('id', 'name', 'background', 'tags', 'providers', 'last_session_filters as lastSessionFilters');
    const rounds = [];
    // Awaited one at a time: a single transaction runs on ONE connection and
    // cannot serve concurrent queries (see the tx note above).
    for (const row of rows) {
      const children = await childrenOf(trx, tenant, row.id);
      const acts = await trx('activities')
        .where({ round_id: row.id, tenant_id: tenant })
        .orderBy('seq')
        .select('id', 'data');
      rounds.push({ ...assemble(row, children), activities: acts.map(withId) });
    }
    return { tenantId: tenant, rounds };
  });
}

// Erase an account AND its tenant's round data, returning the freed
// '/uploads/<key>' paths so the ROUTE can delete the stored objects — the same
// clear-the-reference-then-delete-the-bytes ordering takedownImage uses.
// Children (members/games/sessions/activities) go with the round via the
// schema's ON DELETE CASCADE.
//
// Returns null for an unknown account, 'tenant_shared' when another account
// still lives on the tenant, else { tenantId, rounds, images }.
async function eraseAccount(uid) {
  const user = await getUserById(uid);
  if (!user) return null;
  const tenant = user.tenantId || null;

  // See the JSON backend for why a shared tenant must refuse rather than cascade.
  if (tenant) {
    const other = await knex('users')
      .whereRaw("data->>'tenantId' = ?", [tenant])
      .andWhereNot({ id: uid })
      .first('id');
    if (other) return 'tenant_shared';
  }

  let rounds = 0;
  const images = new Set();
  if (tenant) {
    await tx(tenant, async (trx) => {
      // Collected BEFORE the delete — the rows are gone afterwards. Deduped: an
      // imported round shares the cover path rather than the file.
      const games = await trx('games')
        .where({ tenant_id: tenant })
        .whereRaw("data->>'image' IS NOT NULL")
        .select('data');
      for (const g of games) images.add(g.data.image);
      rounds = await trx('rounds').where({ tenant_id: tenant }).del();
    });
  }

  await knex('users').where({ id: uid }).del();
  return { tenantId: tenant, rounds, images: [...images] };
}

// Global, un-scoped, no RLS — operator data ABOUT tenants (like `users`).
async function logModeration(entry) {
  const eid = newId();
  await knex('moderation_log').insert({ id: eid, data: J(entry) });
  return { id: eid, ...entry };
}

// `offset` skips that many of the newest entries, so (limit, offset) walks
// backwards through history a page at a time (#288).
async function listModeration(limit = 100, offset = 0) {
  const rows = await knex('moderation_log')
    .orderBy('seq', 'desc').offset(offset).limit(limit)
    .select('id', 'data');
  return rows.map(withId);
}

async function countModeration() {
  return count('moderation_log');
}

/* --------------------------------- Feedback --------------------------------- */
/*
 * In-app user feedback (issue #260). Global and un-scoped, no RLS — the same
 * treatment as `users` and `moderation_log`, and for the same reason: it is data
 * addressed TO the operator, who must read it across every tenant. Absent from
 * TENANT_METHODS, so only the admin-gated routes can reach the read side.
 */

async function createFeedback(entry) {
  const fid = newId();
  await knex('feedback').insert({ id: fid, data: J(entry) });
  return { id: fid, ...entry };
}

async function listFeedback(limit = 100, offset = 0) {
  const rows = await knex('feedback')
    .orderBy('seq', 'desc').offset(offset).limit(limit)
    .select('id', 'data');
  return rows.map(withId);
}

async function countFeedback() {
  return count('feedback');
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
      completed: false,
      completedAt: null,
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

// A game is Active, Retired or Completed — never two at once (#250), so setting
// one archived state clears the other. See the JSON backend for the contract.
async function retireGame(tenant, rid, gid, retired) {
  return tx(tenant, async (trx) => {
    const patch = { retired, retiredAt: retired ? new Date().toISOString() : null };
    if (retired) Object.assign(patch, { completed: false, completedAt: null });
    const rows = await trx('games').where({ id: gid, round_id: rid, tenant_id: tenant }).update({ data: mergeData(patch) }).returning(['id', 'data']);
    if (!rows[0]) return null;
    await addActivity(trx, tenant, rid, retired ? 'game_retired' : 'game_restored', {
      gameId: gid,
      title: rows[0].data.title,
    });
    return withId(rows[0]);
  });
}

async function completeGame(tenant, rid, gid, completed) {
  return tx(tenant, async (trx) => {
    const patch = { completed, completedAt: completed ? new Date().toISOString() : null };
    if (completed) Object.assign(patch, { retired: false, retiredAt: null });
    const rows = await trx('games').where({ id: gid, round_id: rid, tenant_id: tenant }).update({ data: mergeData(patch) }).returning(['id', 'data']);
    if (!rows[0]) return null;
    await addActivity(trx, tenant, rid, completed ? 'game_completed' : 'game_uncompleted', {
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
    if (!game.retired && !game.completed) return 'not_archived';

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

// Move every game of one round into another round of the same tenant, merging
// tags by name (#253). See the JSON backend for the contract and the rationale
// for the quota check living here.
//
// Both round rows are locked in ONE statement ordered by id, so two concurrent
// moves between the same pair of rounds in opposite directions serialize
// instead of deadlocking (each would otherwise hold the row the other wants).
// Sequential awaits throughout: one transaction runs on one connection.
async function moveGames(tenant, rid, targetRid, limits) {
  return tx(tenant, async (trx) => {
    if (rid === targetRid) return 'same_round';
    const rows = await trx('rounds')
      .whereIn('id', [rid, targetRid])
      .andWhere({ tenant_id: tenant })
      .orderBy('id')
      .forUpdate()
      .select('id', 'name', 'tags');
    const src = rows.find((r) => r.id === rid);
    const target = rows.find((r) => r.id === targetRid);
    if (!src || !target) return null;

    const moving = await trx('games')
      .where({ round_id: rid, tenant_id: tenant })
      .orderBy('seq')
      .select('id', 'data');
    const targetTags = target.tags || [];

    const used = new Set();
    for (const g of moving) for (const x of g.data.tagIds || []) used.add(x);

    const remap = new Map();
    const created = [];
    let mergedTags = 0;
    const norm = (s) => s.trim().toLowerCase();
    for (const tag of src.tags || []) {
      if (!used.has(tag.id)) continue;
      const match = targetTags.find((tg) => norm(tg.name) === norm(tag.name));
      if (match) {
        remap.set(tag.id, match.id);
        mergedTags += 1;
        continue;
      }
      const fresh = { id: newId(), name: tag.name };
      if (tag.icon) fresh.icon = tag.icon;
      created.push(fresh);
      remap.set(tag.id, fresh.id);
    }

    if (limits) {
      const [{ count }] = await trx('games').where({ round_id: targetRid, tenant_id: tenant }).count();
      if (Number(count) + moving.length > limits.maxGames) return 'quota_games';
      if (targetTags.length + created.length > limits.maxTags) return 'quota_tags';
    }

    const movedGames = moving.length;
    if (created.length) {
      // `tags` is an ARRAY — J() it (see the header note on the JSONB footgun).
      await trx('rounds')
        .where({ id: targetRid, tenant_id: tenant })
        .update({ tags: J([...targetTags, ...created]) });
    }

    // Reparent one game at a time, in the source's shelf order, taking a FRESH
    // `seq` for each. Reads order by seq, so keeping the old values would
    // interleave the moved games among the target's existing ones by original
    // insertion time — the JSON backend appends them, and the contract suite
    // compares the assembled rounds, so the two must agree.
    const movedIds = new Set();
    for (const g of moving) {
      movedIds.add(g.id);
      const patch = {
        round_id: targetRid,
        seq: knex.raw("nextval(pg_get_serial_sequence('games', 'seq'))"),
      };
      if (Array.isArray(g.data.tagIds)) {
        patch.data = mergeData({ tagIds: g.data.tagIds.map((x) => remap.get(x)).filter(Boolean) });
      }
      await trx('games').where({ id: g.id, tenant_id: tenant }).update(patch);
    }

    // Scrub the moved games out of the SOURCE round's sessions, same rules as
    // deleteGame; the target's sessions are untouched.
    const sessions = await trx('sessions').where({ round_id: rid, tenant_id: tenant }).select('id', 'data');
    for (const row of sessions) {
      const s = row.data;
      s.gameIds = (s.gameIds || []).filter((x) => !movedIds.has(x));
      if (s.gameIds.length === 0) {
        await trx('sessions').where({ id: row.id, tenant_id: tenant }).del();
        continue;
      }
      for (const mid in s.votes || {}) {
        for (const gid of movedIds) delete s.votes[mid][gid];
      }
      if (movedIds.has(s.chosenGameId)) {
        s.chosenGameId = null;
        s.chosenAt = null;
        s.finished = false;
        s.finishedAt = null;
        s.winnerIds = [];
      }
      await trx('sessions').where({ id: row.id, tenant_id: tenant }).update({ data: J(s) });
    }

    if (movedGames) {
      await addActivity(trx, tenant, rid, 'games_moved_out', {
        count: movedGames, roundId: targetRid, roundName: target.name,
      });
      await addActivity(trx, tenant, targetRid, 'games_moved_in', {
        count: movedGames, roundId: rid, roundName: src.name,
      });
    }

    return { movedGames, mergedTags, createdTags: created.length };
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
async function addTag(tenant, rid, name, icon) {
  return tx(tenant, async (trx) => {
    const row = await trx('rounds').where({ id: rid, tenant_id: tenant }).forUpdate().first('tags');
    if (!row) return null;
    const tags = row.tags || [];
    const existing = tags.find((tg) => tg.name.toLowerCase() === name.toLowerCase());
    // A duplicate name reuses the existing tag and deliberately does NOT adopt
    // the passed icon: creating a tag must never silently restyle one the round
    // already has (#255).
    if (existing) return existing;
    const tag = { id: newId(), name };
    // `icon` stays absent when unset — absent-key parity with the JSON backend.
    if (icon) tag.icon = icon;
    tags.push(tag);
    await trx('rounds').where({ id: rid, tenant_id: tenant }).update({ tags: J(tags) });
    return tag;
  });
}

// Set (or clear, with a null icon) a tag's icon (#255). Returns the updated
// tag, or null when the round or the tag is gone. Name is not patchable —
// renaming a tag is deliberately still unsupported. FOR UPDATE serializes
// concurrent writes to the tags array, like addTag/deleteTag.
async function setTagIcon(tenant, rid, tagId, icon) {
  return tx(tenant, async (trx) => {
    const row = await trx('rounds').where({ id: rid, tenant_id: tenant }).forUpdate().first('tags');
    if (!row) return null;
    const tags = row.tags || [];
    const tag = tags.find((tg) => tg.id === tagId);
    if (!tag) return null;
    if (icon) tag.icon = icon;
    else delete tag.icon;
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

/* --------------------------- Lookup providers (#294) -------------------------- */

// Set which lookup providers this round queries. `ids` is already validated
// against the registry by the route. Returns the stored list, or null if the
// round is gone. The column stays NULL until first configured — NULL means "all
// providers", the pre-#294 behaviour — while an empty array is a distinct,
// legitimate "query nothing". `providers` is an ARRAY, so J() it: a raw array
// binding into jsonb throws 22P02 (see the header note).
async function setProviders(tenant, rid, ids) {
  return tx(tenant, async (trx) => {
    const n = await trx('rounds').where({ id: rid, tenant_id: tenant }).update({ providers: J(ids) });
    return n ? [...ids] : null;
  });
}

module.exports = {
  READ_SQL, // for the plain-role RLS ordering probe in test/repo.postgres.test.js
  init,
  end,
  migrationStatus,
  listRounds,
  listRoundSummaries,
  getRound,
  getRoundMeta,
  getSession,
  getGame,
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
  exportTenant,
  eraseAccount,
  logModeration,
  listModeration,
  countModeration,
  createFeedback,
  listFeedback,
  countFeedback,
  updateMember,
  createGame,
  updateGame,
  retireGame,
  completeGame,
  deleteGame,
  moveGames,
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
  setTagIcon,
  deleteTag,
  setProviders,
};
