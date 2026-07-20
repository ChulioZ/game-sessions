# The operator moderation surface (#268) — the four things that are easy to break

`ADMIN_PASSWORD` turns on `/admin.html` + `/api/admin`: resolve a reported
`/uploads/<key>` to its owning game/round/tenant, take it down, suspend/restore
an account, read the action log. `lib/admin.js` · `routes/admin.js` ·
`public/admin.html` + `public/js/admin.js`. Four non-obvious constraints, all of
which fail *silently* or *dangerously* if undone.

## 1. ADMIN_PASSWORD must never be AUTH_PASSWORD

`lib/admin.js` deliberately mirrors `lib/auth.js`'s **mechanism** (shared
password → stateless HMAC cookie) but not its **secret**, for two reasons:

- `AUTH_PASSWORD` is known to the whole group using the instance. These powers
  are cross-tenant (read any tenant's rows, delete any image, disable any
  account), so sharing the value is a privilege escalation for every member.
  This is the same call `.claude/rules/user-accounts.md` already made for
  `SESSION_SECRET`, which must not fall back to `AUTH_PASSWORD`.
- Sharing it would make an ordinary app session token verify as an admin token,
  so in legacy mode the panel would have **no separate gate at all**.

Because the *signing* secret may still legitimately be a shared `SESSION_SECRET`,
the admin HMAC payload is **domain-separated** (`admin.` prefix) and uses its own
token version (`a1`) and cookie (`aid`, `sameSite=strict`). Keep all three — drop
the prefix and an app `sid` token becomes a valid admin token whenever
`SESSION_SECRET` is set. `test/admin.test.js` asserts an app token is rejected.

## 2. The Postgres RLS admin escape is READ-ONLY — never add it to WITH CHECK

An abuse notice names an image, not a tenant, so the lookup is inherently
cross-tenant — and under `FORCE ROW LEVEL SECURITY` an unscoped read sees zero
rows (fail-closed). Migration `20260720140000_moderation.js` therefore admits
`current_setting('app.admin', true) = 'on'` in the policies' **`USING`** clause,
set transaction-locally by `atx()` in `lib/repo/postgres.js`.

**It is deliberately absent from `WITH CHECK`.** `USING` governs which rows a
statement may *see*; `WITH CHECK` governs rows it may *write*. So the flag can
widen a lookup and can **never** widen a write. That is why `takedownImage`
does not write under the escape: it reads the target rows with `atx()`, then
performs each update through the ordinary tenant-scoped `tx(tenant, …)` path.
Adding the escape to `WITH CHECK` would make a single missed `if` in the admin
routes a cross-tenant write primitive.

## 3. Cross-tenant repo methods must be tested through a PLAIN ROLE

`findImageOwner`/`takedownImage` are covered by the shared contract
(`test/support/repo-contract.js`), but **that suite's Postgres connection is a
superuser, which bypasses RLS entirely** — so those cross-tenant assertions pass
even if the policy change is completely broken. A break would show up only on a
hardened (non-superuser) deploy, as "the operator lookup finds nothing", with CI
green the whole time.

The probe that actually catches it is
`test/repo.postgres.test.js` → *"the moderation admin escape widens reads only,
never writes"*, which creates a dedicated non-superuser role and asserts all
three properties: the flag widens the read, it does **not** permit a cross-tenant
insert, and it dies with the transaction. Same reasoning as the pre-existing
fail-closed probe next to it (see `.claude/rules/tenancy-rls.md`).

## 4. The moderation methods are global on purpose — keep them out of TENANT_METHODS

`findImageOwner`, `takedownImage`, `logModeration`, `listModeration` and
`listUsers` are **absent** from `TENANT_METHODS` in `lib/repo/index.js`. That is
the enforcement, not an oversight: an ordinary request handler only ever holds
`req.repo` (the tenant-scoped facade), so it *cannot* reach them. They live on
the module-level repo, which only the admin-gated `routes/admin.js` requires.
Adding them to `TENANT_METHODS` would both break them (they take no tenant
argument) and expose cross-tenant reads to every route.

Related: `listUsers()` returns the **raw stored user shape**, secrets included —
`routes/admin.js` is what projects it down to the safe fields. Don't respond with
it directly.

## Smaller things worth remembering

- **Suspension is enforced in `lib/tenant.js`,** not only at login. That
  middleware already loads the user row on every `/api` request in accounts mode,
  so the check is free — and unlike refusing at login it bites immediately rather
  than after the 15-minute access-token TTL. Suspension also clears
  `refreshTokens`, which is why a suspended account's refresh returns
  `invalid_refresh_token` rather than `account_disabled` (both refuse; the
  disabled guard in `routes/account.js` remains as defence in depth for a row
  disabled directly in the DB).
- **Takedown clears the DB reference before deleting the bytes.** The reverse
  order would leave a row pointing at a missing object on a partial failure —
  i.e. a permanently broken cover for the user. `cleared: 0` is reported
  honestly rather than as an error.
- **`admin.html` must be in `REWRITE_FILES` in `scripts/build.js`.** Every
  standalone HTML entry point needs to be, or its `<script src>` 404s in a built
  production deploy (the js is content-hashed but the reference isn't rewritten)
  — see `.claude/rules/frontend-build-cache-busting.md`.
- **The page is German-only and outside the i18n system,** following
  `login.html`'s precedent: it is an operator tool with one audience, not
  user-facing product UI, so it carries no `lang/*.js` key-parity obligation.
  It also deliberately links no web manifest, so it never becomes installable or
  offline-cached as part of the app.
