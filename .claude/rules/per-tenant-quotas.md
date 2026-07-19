# Per-tenant quotas (lib/quota.js, issue #139) — gotchas

Issue #139 added per-tenant cost/abuse caps: rounds per tenant, games per round,
and the billed buy-next recommendation call per tenant/month. Things that will
bite if you forget them:

- **Quotas are enforced ONLY when `accounts.accountsEnabled()`** (the public
  multi-tenant mode). `quota.enforced()` gates every check. With accounts off —
  today's single-tenant production behind the shared-password gate, every caller
  the one `'default'` tenant — the caps are inert, so that instance is
  byte-for-byte unchanged and an existing group already past a cap is never
  suddenly blocked. This mirrors how tenancy (#136) and onboarding (#138) gate
  their behaviour. Don't make a quota fire in legacy mode.

- **The recommendation-spend cap is NOT an `express-rate-limit` limiter.** The
  natural "per-tenant rate limiter keyed by req.tenantId, monthly window" hits a
  hard wall: `express-rate-limit`'s MemoryStore resets via `setTimeout(windowMs)`,
  and a ~30-day `windowMs` (2,592,000,000 ms) exceeds Node's 32-bit timer max
  (~24.8 days) → `ERR_ERL_WINDOW_MS` + a `TimeoutOverflowWarning`, the timer fires
  after 1 ms, the window resets instantly, and the cap never holds (the 2nd call
  is allowed). So the monthly cap is a hand-rolled in-memory counter in
  `lib/quota.js` bucketed by **calendar month** (a month key, no timer) instead.
  Don't "restore" it to a rateLimit() with a monthly windowMs.

- **The guard only caps POST, though it's mounted for all methods.** It's added
  with `app.use()` on the recommendations path, which matches GET/POST/DELETE
  alike — so the guard checks `req.method !== 'POST' → next()` first. Otherwise,
  once a tenant spent its 1/month, **GET** (read the run history) and **DELETE**
  (drop a run) would also 429, locking the tenant out of its own past runs. Only
  the billed POST generates and spends.

- **It counts on SUCCESS, it does not reserve.** `recommendationsGuard` refuses
  when the month's count is already at the ceiling, then increments only in a
  `res.on('finish')` when `res.statusCode === 200`. So a 502/503 (no key / upstream
  failure — no real spend) never consumes quota, and — crucially — an **aborted**
  request can't leak a reserved slot and wrongly block the tenant for the whole
  month. The only tradeoff is that a burst of truly concurrent calls could each
  slip past the check before any finishes; that's a non-issue for a once-a-month
  button and far better than the reserve-then-refund abort-leak.

- **The per-IP recs limiter still stacks in front.** The route mounts
  `recommendationsLimiter` (per-IP burst, `RECS_RATE_LIMIT_MAX`) *then*
  `quota.recommendationsGuard` (per-tenant monthly spend). They're independent
  layers — the per-IP one still applies in legacy mode where the tenant guard is
  inert. Both run after `withTenant`, so `req.tenantId` is set by the time the
  guard reads it.

- **State caps count current data; deleting frees the slot.** The rounds cap
  counts `req.repo.listRounds().length` (tenant-scoped) and the games cap counts
  `round.games.length` (**active + retired** — both hold a row and a possible
  cover). They're checked *before* persisting: the games check sits after the
  round-404 check but before `saveUploadedImage`/`downloadCover`, so a refused add
  leaves no orphan file even though multer already buffered the upload in memory.
  There is deliberately no `countRounds` repo method — reusing `listRounds` avoids
  widening the repo contract for a ≤10-row count.

- **All ceilings are read per call, from env** (`MAX_ROUNDS_PER_TENANT`,
  `MAX_GAMES_PER_ROUND`, `RECS_TENANT_MONTHLY_MAX`; defaults 10 / 1000 / 1), so a
  test — or a live re-tune — picks up the current env without a rebuild, matching
  the rate-limit ceilings in `lib/app.js` (see `security-middleware.md`).

- **Error contract → frontend toasts.** The three refusals return distinct codes:
  `403 quota_rounds`, `403 quota_games`, `429 quota_recommendations`. `core.js`
  `api()` throws `new Error(payload.error)`, so each catch maps the code to a
  localized toast (`newRound.toast.quota`, `addGame.toast.quota`, `buynext.quota`
  in `lang/{de,en}.js`). The `limit` field in the 403 body is not surfaced (api()
  drops it) — the messages are intentionally number-free since the limits are
  env-tunable.

- **Testing needs accounts ON** (so the caps aren't inert) and must **never hit
  the real LLM** (`no-real-llm-calls-in-tests.md`). `test/quota.test.js` enables
  accounts, drives real tenants via the register→verify→login helper (like
  `test/tenant.test.js`), sets tiny ceilings via env, and stubs `global.fetch` for
  the recs cap. It also asserts inertness with a fresh `createApp()` built with
  accounts off.
