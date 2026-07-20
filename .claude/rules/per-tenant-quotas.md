# Per-tenant quotas (lib/quota.js, issue #139) — gotchas

Issue #139 added per-tenant cost/abuse caps: rounds per tenant, games per round,
and (since #238) tags per round. All three are **state caps** — they count
current data rather than metering a rate. Things that will bite if you forget
them:

- **Quotas are enforced ONLY when `accounts.accountsEnabled()`** (the public
  multi-tenant mode). `quota.enforced()` gates every check. With accounts off —
  today's single-tenant production behind the shared-password gate, every caller
  the one `'default'` tenant — the caps are inert, so that instance is
  byte-for-byte unchanged and an existing group already past a cap is never
  suddenly blocked. This mirrors how tenancy (#136) and onboarding (#138) gate
  their behaviour. Don't make a quota fire in legacy mode.

- **State caps count current data; deleting frees the slot.** The rounds cap
  counts `req.repo.listRounds().length` (tenant-scoped) and the games cap counts
  `round.games.length` (**active + retired** — both hold a row and a possible
  cover). They're checked *before* persisting: the games check sits after the
  round-404 check but before `saveUploadedImage`/`downloadCover`, so a refused add
  leaves no orphan file even though multer already buffered the upload in memory.
  There is deliberately no `countRounds` repo method — reusing `listRounds` avoids
  widening the repo contract for a ≤10-row count.

- **All ceilings are read per call, from env** (`MAX_ROUNDS_PER_TENANT`,
  `MAX_GAMES_PER_ROUND`, `MAX_TAGS_PER_ROUND`; defaults 10 / 1000 / 30), so a
  test — or a live re-tune — picks up the current env without a rebuild, matching
  the rate-limit ceiling in `lib/app.js` (see `security-middleware.md`).

- **Error contract → frontend toasts.** The three refusals return distinct codes:
  `403 quota_rounds`, `403 quota_games`, `403 quota_tags`. `core.js`
  `api()` throws `new Error(payload.error)`, so each catch maps the code to a
  localized toast (`newRound.toast.quota`, `addGame.toast.quota`,
  `tags.toast.quota` in `lang/{de,en}.js`). The `limit` field in the 403 body is
  not surfaced (api() drops it) — the messages are intentionally number-free
  since the limits are env-tunable.

- **Testing needs accounts ON** (so the caps aren't inert). `test/quota.test.js`
  enables accounts, drives real tenants via the register→verify→login helper
  (like `test/tenant.test.js`), and sets tiny ceilings via env. It also asserts
  inertness with a fresh `createApp()` built with accounts off.

**Historical note (#264):** there used to be a fourth cap — a per-tenant monthly
limit on the *billed* buy-next LLM call, implemented as a hand-rolled
calendar-month counter rather than an `express-rate-limit` limiter (a ~30-day
`windowMs` overflows Node's 32-bit timer and the cap silently never holds). It
counted on success rather than reserving, so an aborted request couldn't leak a
slot. All of it went away with the feature in #264; the note survives only so
nobody reinvents a monthly `rateLimit()` window and hits the same timer trap.
