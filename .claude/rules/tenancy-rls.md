# Tenancy (#136): routes use req.repo; Postgres RLS binds non-superusers only

Issue #136 made every piece of round data tenant-scoped. How it hangs together,
and the traps that cost effort:

- **Routes never call round methods on the module-level repo.** The tenant
  middleware (`lib/tenant.js`, mounted on `/api` after the auth gate) resolves
  the caller's tenant — accounts enabled + valid Bearer token → the user's
  `tenantId`, otherwise `'default'` (today's whole production instance) — and
  sets `req.repo = repo.forTenant(tid)`. Handlers use **`req.repo`** for
  everything round-scoped; only the *global* user methods
  (`getUserById`, `createUser`, …) stay on `require('../lib/repo')`. A new
  round-scoped repo method must be added to `TENANT_METHODS` in
  `lib/repo/index.js` or `req.repo.<method>` is undefined.

- **Repo methods are tenant-first.** Both backends take `tenant` as the first
  argument on every round-scoped method, filter/write it on **every** statement
  (children carry `tenant_id` denormalized), and treat a wrong-tenant lookup
  exactly like not-found. The contract suite runs as tenant `'tenant-a'`
  (deliberately not `'default'`, so nothing passes by accident of the schema
  default) and probes isolation as `'tenant-b'`.

- **`tenantId` is scoping metadata, not payload.** Snapshots/assembled rounds
  never include it, so API shapes and the frontend are unchanged. Existing JSON
  rounds without the key count as tenant `'default'` (`tenantOf` in
  `lib/repo/json.js`) — don't "migrate" the live file to add it.

- **Postgres RLS is the backstop, not the primary filter — and superusers
  BYPASS it.** Policies (`ENABLE` + `FORCE ROW LEVEL SECURITY`, recreated
  idempotently in `init()`) compare `tenant_id` to the transaction-local setting
  `app.tenant_id`; `current_setting(..., true)` is NULL when unset, so an
  unscoped query sees zero rows (fail-closed). But **`FORCE` only binds
  non-superuser roles** — a superuser connection (Railway's default `postgres`
  user, CI's service container) skips RLS entirely. That's why
  `test/repo.postgres.test.js` probes through a dedicated plain role, and why a
  hardened deploy should run the app as a non-superuser (see
  `docs/deploy-railway.md`). The app-layer WHERE clauses are the enforcement
  that always holds.

- **Every round-table statement must run inside a transaction that sets the
  tenant.** `tx(tenant, fn)` sets `app.tenant_id` with `set_config(..., true)`
  (transaction-local — it dies at COMMIT/ROLLBACK, so no tenant ever leaks to
  the next pooled checkout); `qt(tenant, text, params)` wraps one statement.
  Never use bare `pool.query` on rounds/members/games/sessions/activities: under
  a non-superuser role it returns zero rows and "no data" bugs look like data
  loss. The users table is deliberately un-scoped (identity layer, looked up by
  email before any tenant is known) and keeps plain `q()`.

- **`TRUNCATE` is not subject to RLS** (it's table-level, needs its own
  privilege) — that's why the Postgres test files' cleanup keeps working as-is.

- **Registration mints a personal tenant** (`routes/account.js`): each new user
  gets a fresh `tenantId`. Sharing a tenant (invites/memberships) is #207;
  roles within one are #137. Both were reclassified 2026-07-19 as **not
  go-live blockers** (docs/production-readiness.md §12 — neither carries a
  GitHub blocking relation to the go-live issue #219 in either direction) —
  because "member" is already decoupled from "user" (a name-only seat the
  owner adds), so a single-owner tenant is a complete product without either.
  There is intentionally **no tenants table** yet — the first issue that gives
  a tenant fields (name, settings, quotas #139) adds the entity.
