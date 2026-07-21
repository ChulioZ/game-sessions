# The operator moderation surface (#268/#273/#274/#275) — traps

`ADMIN_PASSWORD` turns on `/admin.html` + `/api/admin`: lookup/takedown/
redaction, account suspend/restore, GDPR export/erasure, the action log, the
status card. `lib/admin.js` · `routes/admin.js` · `public/admin.html` +
`public/js/admin.js`. Every trap below fails *silently* or *dangerously* if
undone.

## 1. ADMIN_PASSWORD must never be AUTH_PASSWORD

`AUTH_PASSWORD` is known to the whole group; these powers are cross-tenant, so
sharing the value is privilege escalation for every member (same call
`user-accounts.md` made for `SESSION_SECRET`). And since the *signing* secret
may legitimately be a shared `SESSION_SECRET`, the admin HMAC payload is
**domain-separated** (`admin.` prefix, own token version `a1`, own cookie
`aid`, `sameSite=strict`). Drop the prefix and an app `sid` token becomes a
valid admin token whenever `SESSION_SECRET` is set. `test/admin.test.js`
asserts an app token is rejected.

## 2. The RLS admin escape is a separate `FOR SELECT` policy — never `OR`ed onto the existing one

Abuse lookups are inherently cross-tenant (a notice names an image, not a
tenant), so migration `20260720140000_moderation.js` admits
`current_setting('app.admin', true) = 'on'`, set transaction-locally by
`atx()` in `lib/repo/postgres.js`. The tempting shape — `OR` the flag into the
existing `FOR ALL` policy's `USING` clause — silently permits cross-tenant
**`DELETE`**: `DELETE` is governed by `USING` alone (there is no `WITH CHECK`
for it). Measured on a real DB: a cross-tenant `DELETE FROM games` under that
shape reports `rowCount 1`.

Correct shape (what the migration does): leave `<t>_tenant_isolation`
untouched and add a separate, additive `<t>_admin_read` policy that is
**`FOR SELECT` only**. Permissive policies OR-combine *per command*, so reads
widen while writes still consult only the tenant policy — read-only becomes
structural, not convention. `takedownImage` accordingly reads under `atx()`
and writes through the ordinary `tx(tenant, …)` path.

## 3. Cross-tenant behaviour must be tested through a PLAIN ROLE

The contract suite's Postgres connection is a **superuser, which bypasses RLS
entirely** — its cross-tenant assertions pass even with the policies broken.
The probes that actually catch a break live in `test/repo.postgres.test.js`
and run through a dedicated non-superuser role:

- *"the moderation admin escape widens reads only, never writes"* — the flag
  widens SELECT but refuses cross-tenant INSERT/UPDATE/**DELETE** (the DELETE
  assertion pins §2's trap) and dies with the transaction.
- *"erasure deletes tenant rows as a non-superuser under FORCE RLS"* — §5.
- *"redaction writes tenant-scoped, never under the read-only admin escape"* —
  §7. This one runs **the repo method itself** as the plain role via a child
  process (`DATABASE_URL` pointed at the probe role — the knex is built at
  require time, so a child is the only way) and asserts the **stored value
  changed**, not merely that the call reported success.

**Rule:** any future operator write gets an end-to-end plain-role probe, not
just a hand-written-SQL policy probe — and break the code on purpose once to
watch the probe fail. Verified on #275: with `redactText` deliberately
rewritten onto `atx()`, everything except that one child-process assertion
stayed green.

## 4. Moderation methods are global on purpose — keep them out of TENANT_METHODS

`findImageOwner`, `takedownImage`, `logModeration`, `listModeration`,
`listUsers`, `exportTenant`/`eraseAccount` (#273),
`findRoundOwner`/`tenantSummary`/`roundContent`/`redactText`/
`moderationActions` (#275) and `migrationStatus` are **absent** from
`TENANT_METHODS` (`lib/repo/index.js`). That absence is the enforcement:
handlers only hold `req.repo`, so they cannot reach cross-tenant methods; only
the admin-gated `routes/admin.js` requires the module-level repo. Adding one
to `TENANT_METHODS` would both break it (no tenant argument) and expose
cross-tenant reads to every route. Also: `listUsers()` returns the raw stored
user shape **including secrets** — `routes/admin.js` projects it down to the
safe fields; never respond with it directly.

## 5. Erasure & export (#273) run tenant-scoped — the admin escape cannot delete

`exportTenant`/`eraseAccount` do **not** use `atx()`: resolving the account
yields its tenant, and for erasure the tenant path is *required* — a `DELETE`
inside `atx()` matches zero rows (§2), so `eraseAccount` would report
`rounds: 0` **while claiming success**: a legal erasure duty that quietly
erases nothing.

Also baked into erasure: it refuses with `'tenant_shared'` → 409 when a second
account shares the tenant (the no-undo mistake once tenant sharing #207
lands); the log entry carries **no erased personal data** (account id, tenant,
date, reason, counts — the record outlives the erasure it evidences); the
route demands the account's own e-mail as `confirmEmail`, checked server-side.
Sharper related trap: `.claude/rules/erased-account-token-fallback.md` — the
stateless access token outlives the deleted row.

## 6. The status card (#274) reports DERIVED values — the sweep test is the guard

`lib/status.js` must never let a secret reach the response — not truncated,
not hashed (the panel is password-gated, and a screenshot of it must be
harmless). Enforced generically: `test/status.test.js` plants recognisable
values in the secret env vars, serializes the whole response, and asserts none
appears — plus no long hex blob, which catches "I'll just show a hash". A new
leaking field fails without anyone extending the test; keep the sweep generic.

- `distinct(a, b)` (the "ADMIN_PASSWORD equals AUTH_PASSWORD?" check) uses the
  bare length-check + `timingSafeEqual` idiom and returns only the verdict.
  **Don't "harden" it by hashing the operands first** — a SHA-256 there made
  CodeQL fail the PR with high-severity `js/insufficient-password-hash`, and
  the un-hashed form is better code anyway (the only thing the length
  short-circuit reveals is whether two secrets share a length, to an operator
  who is handed the equality verdict itself).
- The server reports facts; the ok/warn/off opinions live in `statusRows()`
  (`public/js/admin.js`), so changing an opinion never changes the API shape.
- `assetsBuilt()` lives in `lib/status.js` and `lib/app.js`'s `assetDir()`
  calls it — one copy. Direction matters: `status.js` must never require
  `lib/app.js` (cycle: app → routes/admin → status).
- `migrationStatus()` exists on both backends; JSON answers
  `{ backend:'json', latest:null, pending:0 }` instead of throwing.
  `pending > 0` means the code shipped but the schema did not.

## 7. Redaction (#275): reads are cross-tenant, writes are NOT

`redactText`'s reads (`findRoundOwner`/`tenantSummary`/`roundContent`) are
genuinely cross-tenant, so doing the whole method inside `atx()` looks natural
— and produces the worst silent failure: the SELECT succeeds, the UPDATE
matches zero rows, and because the return value derives from the row *read*,
the route logs a successful takedown **while the content stays live for every
user**. So `redactText` resolves the tenant under `atx()` and performs every
write via `tx(tenant, …)`, exactly like `takedownImage`. Testing: §3.

## 8. Redaction blanks TEXT; it must never delete a row

`redactText` overwrites one field with the fixed marker `'[entfernt]'` and
returns the previous value.

- A tag is redacted by **name only — its id survives** (deleting or re-minting
  it would strip the tag from every `game.tagIds`; the contract suite asserts
  id and references untouched).
- The replacement is **fixed, not operator-supplied** — free text would be a
  larger power than the one exercised, and an empty string reads like a bug.
- The original wording lives on the log entry (`previous`) and the CSV's
  `Vorher` column — after blanking it is the only remaining evidence, which is
  precisely what an Art. 17 statement of reasons must quote.

There are **no rating comments** (votes are numeric), so user-authored text is
exactly: round name, game title, member name, tag name, feedback message.
Feedback is global/un-scoped → it redacts by id alone, no tenant transaction.

## 9. Inclusive date bounds are load-bearing, and asymmetric

The log filter widens a bare `YYYY-MM-DD` in **opposite** directions: `from` →
`T00:00:00.000Z`, `to` → `T23:59:59.999Z` (a naive `at <= '2026-07-20'` hides
the whole 20th from the record backing Art. 17). The widening happens in the
ROUTE so both backends receive exact instants; `at` is compared as **text**
(ISO-8601 sorts lexicographically), so one malformed historical value can't
error the whole query. `countModeration` and `/log.csv` honour the same filter
— otherwise the card's "20 von 300" lies, and an export prepared for one
account silently widens to every tenant.

## 10. Per-tenant storage bytes are best-effort and capped

`storage.size(publicPath)` is guarded in `lib/storage/index.js` the same way
`remove()` is: both backends `path.basename()` the input, so a hotlinked
provider URL (#172) ending in `/pic123.jpg` would size **our** object of that
name and report a stranger's bytes. The route sizes at most `SIZE_SAMPLE_MAX`
(500) objects and reports `{ count, sized, bytes, complete }` so the panel can
render "≥" rather than a wrong total; unreadable objects are skipped.

## Smaller things

- **Suspension is enforced in `lib/tenant.js`** (which already loads the user
  row per `/api` request), so it bites immediately rather than after the
  15-min access-token TTL. It also clears `refreshTokens`, so a suspended
  refresh answers `invalid_refresh_token`; the `account_disabled` guard in
  `routes/account.js` stays as defence in depth.
- **Takedown clears the DB reference before deleting the bytes** — the reverse
  order leaves a permanently broken cover on partial failure. `cleared: 0` is
  reported honestly rather than as an error.
- **`admin.html` must be in `REWRITE_FILES` in `scripts/build.js`** or its
  `<script src>` 404s in a built production deploy — see
  `.claude/rules/frontend-build-cache-busting.md`.
- **The page is German-only, outside the i18n system** (operator tool,
  `login.html` precedent — no `lang/*.js` parity obligation), and links no web
  manifest, so it never becomes installable or offline-cached.
