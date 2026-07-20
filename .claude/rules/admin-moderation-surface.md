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

## 2. The RLS admin escape must be a separate `FOR SELECT` policy — NOT `OR` bolted onto the existing one

An abuse notice names an image, not a tenant, so the lookup is inherently
cross-tenant — and under `FORCE ROW LEVEL SECURITY` an unscoped read sees zero
rows (fail-closed). Migration `20260720140000_moderation.js` therefore admits
`current_setting('app.admin', true) = 'on'`, set transaction-locally by `atx()`
in `lib/repo/postgres.js`.

**The obvious implementation is wrong and was caught in review.** Adding
`OR current_setting('app.admin', …)` to the existing `FOR ALL` policy's `USING`
clause, leaving `WITH CHECK` tenant-matched, *looks* read-only. It isn't:

> **`DELETE` is governed by `USING` alone — there is no `WITH CHECK` for
> `DELETE`.**

So that shape silently permits a cross-tenant `DELETE` from inside any admin
transaction. Measured on a real database before the rewrite: with the flag set, a
cross-tenant `DELETE FROM games` reported `rowCount 1`; without it, `0`.

The correct shape, and what is in the migration: **leave `<t>_tenant_isolation`
completely untouched** (still `FOR ALL`, tenant-matched on both clauses) and add
a **separate, additive `<t>_admin_read` policy that is `FOR SELECT` only**.
Postgres OR-combines permissive policies *per command*, so `SELECT` passes on
"tenant matches OR admin is on" while `INSERT`/`UPDATE`/`DELETE` consult only the
tenant policy. Write isolation is then byte-for-byte what it was before #268, and
the read-only property is **structural** — a `DELETE` or `UPDATE` someone later
writes inside `atx()` is refused by the database, not merely by convention.

`takedownImage` accordingly reads its targets under `atx()` and then performs
each update through the ordinary tenant-scoped `tx(tenant, …)` path.

## 3. Cross-tenant repo methods must be tested through a PLAIN ROLE

`findImageOwner`/`takedownImage` are covered by the shared contract
(`test/support/repo-contract.js`), but **that suite's Postgres connection is a
superuser, which bypasses RLS entirely** — so those cross-tenant assertions pass
even if the policy change is completely broken. A break would show up only on a
hardened (non-superuser) deploy, as "the operator lookup finds nothing", with CI
green the whole time.

The probe that actually catches it is
`test/repo.postgres.test.js` → *"the moderation admin escape widens reads only,
never writes"*, which creates a dedicated non-superuser role and asserts: the
flag widens the read, it does **not** permit a cross-tenant `INSERT`, `UPDATE`
**or `DELETE`** (the `DELETE` assertion is specifically what pins down the trap
in §2 — it returns `rowCount 1` under the wrong policy shape and `0` under the
right one), and it dies with the transaction. Same reasoning as the pre-existing
fail-closed probe next to it (see `.claude/rules/tenancy-rls.md`).

## 4. The moderation methods are global on purpose — keep them out of TENANT_METHODS

`findImageOwner`, `takedownImage`, `logModeration`, `listModeration`,
`listUsers` and (since #273) `exportTenant`/`eraseAccount` are **absent** from
`TENANT_METHODS` in `lib/repo/index.js`. That is
the enforcement, not an oversight: an ordinary request handler only ever holds
`req.repo` (the tenant-scoped facade), so it *cannot* reach them. They live on
the module-level repo, which only the admin-gated `routes/admin.js` requires.
Adding them to `TENANT_METHODS` would both break them (they take no tenant
argument) and expose cross-tenant reads to every route.

Related: `listUsers()` returns the **raw stored user shape**, secrets included —
`routes/admin.js` is what projects it down to the safe fields. Don't respond with
it directly.

## 5. Erasure & export (#273) run tenant-scoped — the admin escape cannot delete

`exportTenant`/`eraseAccount` deliberately do **not** use `atx()`. Resolving the
named account already yields its tenant, so both are single-tenant work and go
through the ordinary `tx(tenant, …)` path. For the export that is merely tighter;
for the erasure it is **required**, and getting it wrong fails silently:

> The admin policy is `FOR SELECT` only (§2). A `DELETE` inside `atx()` is
> filtered by the tenant policy alone, which contributes nothing when
> `app.tenant_id` is unset — so it matches **zero rows** and `eraseAccount`
> reports `rounds: 0` while claiming success. A legal erasure duty that quietly
> erases nothing.

`test/repo.postgres.test.js` → *"erasure deletes tenant rows as a non-superuser
under FORCE RLS"* pins both halves down through a dedicated plain role (§3's
reasoning: CI's superuser bypasses RLS, so the contract suite cannot catch it).

Three more things baked into the erasure and worth keeping:

- **It refuses when a second account shares the tenant** (`'tenant_shared'` →
  `409`). Erasure cascades the whole tenant, so co-tenant data would be deleted
  unrequested. Unreachable today (registration mints a personal tenant) but
  tenant sharing is #207, and this is the mistake with no undo.
- **The log entry carries no erased personal data** — account id, tenant, date,
  reason and counts only, explicitly *not* the e-mail every other action logs.
  The record outlives the erasure, so copying the address into it would defeat
  the erasure it exists to evidence.
- **The route requires the account's own e-mail as `confirmEmail`**, checked
  server-side, so a mis-clicked row refuses instead of erasing the wrong person.

Related, and the sharper trap #273 uncovered:
`.claude/rules/erased-account-token-fallback.md` — deleting a user row is not
enough on its own, because their stateless access token outlives it.

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
