# The PostgreSQL data-access backend (lib/repo/postgres.js) — gotchas

Issue #127 added a second data-access backend behind `DATABASE_URL`
(`lib/repo/index.js` picks `postgres.js` when it's set, else `json.js`). Both
implement the same contract (`.claude/rules/data-access-layer.md`); the shared
suite `test/support/repo-contract.js` runs against **both** — JSON in
`test/repo.test.js`, Postgres in `test/repo.postgres.test.js`. When you add a repo
method, implement it in **both** backends and it's covered by the one contract.

Non-obvious things that cost effort — keep them:

- **JSONB params: `JSON.stringify` the value and cast `$n::jsonb`.** node-postgres
  turns a JS **array** parameter into a Postgres *array literal* (`{...}`), not
  JSON — so passing `runs`/`gameIds` straight into a `jsonb` column silently
  corrupts it. Always pass `J(value)` (= `JSON.stringify`) and write `$n::jsonb`
  (and `data || $n::jsonb` for a patch merge). Reads come back already parsed
  (pg's jsonb parser → JS objects).

- **A single client can't run concurrent queries.** Inside a transaction
  (`tx(fn)` uses one pooled client), you must `await` queries **one at a time** —
  `Promise.all` on the same client throws (a hard error in pg 9; today a
  deprecation). That's why `childrenOf` awaits its four SELECTs sequentially. Only
  `listRounds` uses `Promise.all`, and only because those are `pool.query` calls
  (each gets its own connection). If you see "client is already executing a
  query," you fired concurrent queries on one client.

- **Backend parity of *absent* keys.** The JSON model omits some keys until
  written (a fresh round has no `recommendationRuns`; a fresh member no `color`).
  Postgres matches this: `recommendation_runs` defaults to **NULL** and `assemble`
  emits `recommendationRuns` only when non-null; member/game/session fields live in
  a `data jsonb` blob so "key absent" round-trips naturally. `background` is the
  exception — always present (may be `null`), because the JSON model always sets
  it. If you add a sometimes-absent field, don't give its column a non-null
  default, or the two backends will disagree and the contract test will catch it.

- **jsonb does not preserve key order.** Postgres normalizes jsonb keys, so a
  round/game serialized from Postgres has a different key *order* than from JSON.
  This is cosmetic (the frontend and `assert.deepEqual` are order-independent);
  don't try to "fix" it.

- **Lifecycle.** `server.js` must `await repo.init()` before `listen()` (Postgres
  ensures its schema there; `json.init()` is a no-op). Tests that select the
  Postgres backend must `await repo.end()` in an `after()` hook or the pool keeps
  the process alive. `test/repo.postgres.test.js` **skips** entirely without
  `DATABASE_URL`, so plain `npm test` and the `coverage:ci` gate never touch
  Postgres (and `postgres.js` isn't loaded there, so it isn't coverage-gated — the
  dedicated `postgres` CI job with a service container is what exercises it).

- **`init()` holds a transaction-scoped advisory lock, and the two PG test
  files must run serially.** Two lessons from one flake (#202): (1) concurrent
  `init()` calls on an empty catalog (overlapping deploy instances, parallel
  local runs) can crash with a `pg_class` unique_violation — `CREATE … IF NOT
  EXISTS` does *not* prevent that known Postgres race, so `init()` wraps the
  schema DDL in `pg_advisory_xact_lock` (self-releasing; don't "simplify" it
  away). (2) `test/repo.postgres.test.js` and `test/migrate.postgres.test.js`
  share the one `DATABASE_URL` database and the migrate spec TRUNCATEs it, so
  they are only correct run **serially** — CI uses `--test-concurrency=1`
  (see ci.yml); do the same for local runs of both files together. A parallel
  run now fails on data assertions (rounds vanishing mid-test) instead of
  catalog errors — that's the harness misuse, not an app bug.

**Migrating data.json -> Postgres preserves ids.** The one-off tool
`scripts/migrate-json-to-postgres.js` (`npm run migrate:postgres`, server stopped,
empty target) reads `data.json` and calls **`repo.importRounds(rounds)`** — a
bulk insert that keeps each entity's existing id, because the app's `create*`
methods *mint new ids*, which would break every cross-reference (votes maps keyed
by member/game id, `chosenGameId`, `winnerIds`, `gameIds`, activity `gameId`).
`importRounds` is the inverse of `assemble()` and lives on both backends (JSON for
symmetry/contract coverage); if you change the storage shape, change it too. The
migration folds the pre-#115 legacy `recommendations` object into
`recommendationRuns` (defensively) and refuses a non-empty target.

**Why the storage shape is tables-of-jsonb, not fully normalized:** the roadmap
(§3) explicitly allows JSONB for the messy bits (votes maps, activity payloads),
and the app never queries sessions/votes by field in SQL — routes fetch a whole
round and filter in JS. So each entity is a row with a `data jsonb` (plus promoted
columns only for FKs/ordering/`tenant_id`). `tenant_id` (default `'default'`) is a
forward hook for multi-tenancy (#136); this backend does **not** filter on it yet.
Fuller normalization (a `session_votes` table, real `users`/`tenants`) is later
roadmap work, not a gap to fix here.
