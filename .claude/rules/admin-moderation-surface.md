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
`listUsers`, (since #273) `exportTenant`/`eraseAccount` and (since #275)
`findRoundOwner`/`tenantSummary`/`roundContent`/`redactText`/`moderationActions`
are **absent** from `TENANT_METHODS` in `lib/repo/index.js`. That is
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

## 6. The status card (#274) reports DERIVED values — the sweep test is the guard

`lib/status.js` answers "how is this instance actually configured?" for the
panel's Instanz-Status card. Its one hard rule is that **no secret ever reaches
the response** — not in full, not truncated, not hashed-and-displayed. The panel
is password-gated, not secret-cleared, and a screenshot of it must be harmless.

The obvious way to hold that line is careful review of each field, which decays
the moment someone adds a thirteenth one. So the enforcement is a **generic
sweep** in `test/status.test.js`: it plants recognisable values in
`AUTH_PASSWORD`/`SESSION_SECRET`/`ADMIN_PASSWORD`/`BREVO_API_KEY`, serializes the
whole response, and asserts none of them appears — plus no long hex blob, which
catches "I'll just show a hash". A new field that echoes a secret fails that test
**without anyone remembering to extend it**. Keep the sweep generic; don't
replace it with per-field assertions.

Two related shapes worth keeping:

- **Comparing two secrets returns only the verdict.** `distinct(a, b)` uses the
  same length-check-then-`timingSafeEqual` shape as `lib/admin.js`'s and
  `lib/auth.js`'s `safeEqual`; only the boolean escapes. That is how
  `adminSecretDistinct` / `sessionSecretDistinct` report "ADMIN_PASSWORD equals
  AUTH_PASSWORD" without either value.

  **Do not "harden" this by hashing the operands first.** The first version of
  #274 did (SHA-256, purely to give `timingSafeEqual` equal-length inputs) and
  **CodeQL failed the PR with a high-severity `js/insufficient-password-hash`** —
  a value from `ADMIN_PASSWORD`/`SESSION_SECRET` flowing into a fast hash reads
  as weak password storage to the scanner, and honestly to a human reader too.
  It was a false positive in the strict sense (nothing is stored, transmitted or
  returned — the digests died in the same expression), but the un-hashed form is
  the better code regardless: it matches the existing idiom and needs no
  dismissal. The side-channel it "fixed" does not exist here — the only thing the
  length short-circuit can reveal is whether two secrets share a length, to a
  caller who is already an authenticated operator and who is handed the equality
  verdict itself in the response.
- **The server reports facts; the panel decides what's "good".** The
  ok/warn/off verdicts live in `statusRows()` in `public/js/admin.js`, not in the
  API. So changing an opinion (is a disk image backend a warning or fine?) never
  changes the response shape.

**`assetsBuilt()` lives in `lib/status.js`, and `lib/app.js`'s `assetDir()` calls
it** rather than each deriving `NODE_ENV==='production' && dist/index.html
exists` separately. A second copy would eventually drift, and a card reporting
"built assets" while `public/` is actually being served is worse than not
reporting it at all. Note the direction: `status.js` must never require
`lib/app.js` (that would be a cycle — app → routes/admin → status).

**`migrationStatus()` is on both repo backends and absent from
`TENANT_METHODS`**, like the other operator methods (§4): migration state is a
property of the database, not of any tenant's data, and knex's bookkeeping table
sits outside RLS. The JSON backend answers `{ backend:'json', latest:null,
pending:0 }` rather than throwing, so the panel renders one shape for both. The
field that matters is `pending` — non-zero means the code shipped but the schema
did not, which otherwise surfaces only later as a column-not-found error under
real traffic.

## 7. Redaction (#275) walks into the §2 trap — and a plain-role probe alone does NOT catch it

Redaction is the third operator **write** after takedown (#268) and erasure
(#273), and it is the one where the wrong shape is most tempting: its *reads*
(`findRoundOwner`, `tenantSummary`, `roundContent`) are genuinely cross-tenant, so
doing the whole method inside `atx()` looks natural. On a hardened
(non-superuser) deploy that produces the worst outcome yet:

- the `SELECT` succeeds — the admin policy is `FOR SELECT`;
- the `UPDATE` matches **zero rows** — it consults only the tenant policy, which
  contributes nothing while `app.tenant_id` is unset;
- and because `redactText` derives its return value from the row it *read*, it
  answers `{ previous: 'the illegal title' }`, the route writes a moderation-log
  entry, and the panel reports success — while the reported content is still live
  for every user. **A takedown that took nothing down, on the record as done.**

So `redactText` resolves the tenant under `atx()` and performs every write
through the ordinary `tx(tenant, …)` path, exactly like `takedownImage`.

**The testing lesson is the sharper half.** The obvious guard — a plain-role probe
asserting "UPDATE under `app.admin` = 0 rows, under `app.tenant_id` = 1 row" — is
**vacuous for this regression**, and that was verified rather than assumed: with
`redactText` deliberately rewritten onto `atx()`, the whole suite still passed,
because the probe only exercises hand-written SQL while the end-to-end assertion
runs on this file's **superuser** connection, which bypasses RLS entirely. (The
pre-existing erasure probe in §5 has the same blind spot.)

What actually catches it is running **the repo method itself as the plain role**,
which `test/repo.postgres.test.js` → *"redaction writes tenant-scoped, never under
the read-only admin escape"* does by spawning a **child process** with
`DATABASE_URL` pointed at the probe role — `lib/repo/postgres.js` builds its knex
from `knexfile.js` at require time, so a child is the only way to get a
non-superuser instance of it. The parent then asserts the **stored value changed**,
not merely that the call reported success. Re-verified by breaking the code again:
that one assertion is the only thing in the suite that goes red.

**Rule:** any future operator write gets an end-to-end plain-role probe, not just
a hand-written-SQL policy probe. And before trusting a probe like this, break the
code on purpose and watch it fail — a green suite against broken code is the only
proof that matters here.

## 8. Redaction blanks TEXT; it must never delete a row

`redactText` overwrites one field with the fixed marker `'[entfernt]'` and returns
the previous value. Three deliberate choices:

- **A tag is redacted by name only — its id survives.** Tags are referenced by
  `game.tagIds`, so deleting the tag (or minting a new id) would silently strip a
  tag from every game carrying it. The contract suite asserts the id and the
  referencing `tagIds` are untouched.
- **The replacement is FIXED, not operator-supplied.** A free-text replacement
  would let the panel write arbitrary content into a user's own data — a larger
  power than the one being exercised — and an empty string renders as a blank row
  that reads like a bug rather than a moderation action.
- **The original wording lives on the log entry (`previous`), and in the CSV's
  `Vorher` column.** Once the field is blanked that entry is the *only* remaining
  evidence of what was removed, which is precisely what Art. 17 requires to be
  stated. An export without it is not a complete record.

Note there are **no rating comments** in this schema (votes are numeric), so the
user-authored text is exactly: round name, game title, member name, tag name, and
feedback message. Feedback is global/un-scoped, so it redacts by id alone with no
tenant transaction — like every other `feedback` access.

## 9. Inclusive date bounds are load-bearing, and asymmetric

The log filter accepts a bare `YYYY-MM-DD` (what a date input sends) and widens
the two ends in **opposite** directions: `from` → `T00:00:00.000Z`, `to` →
`T23:59:59.999Z`. A naive `at <= '2026-07-20'` compared against an ISO timestamp
excludes **everything that happened on the 20th** — silently hiding a full day
from the record backing Art. 17. The widening happens in the ROUTE so both
backends receive exact instants and cannot disagree; `at` is then compared as
**text** (ISO-8601 sorts lexicographically) rather than cast to `timestamptz`, so
one malformed historical value can't error the whole query.

`countModeration` takes the same filter as `listModeration` — a total that ignored
it would make the card's "20 von 300" a lie about what "Mehr laden" can reach —
and `/log.csv` honours it too, so "export what I'm looking at" cannot silently
widen a one-account hand-over to every tenant.

## 10. Per-tenant storage bytes are best-effort and capped

`storage.size(publicPath)` (`fs.stat` / `HeadObject`) is guarded in
`lib/storage/index.js` the same way `remove()` is, and for the same reason: both
backends take `path.basename()`, so a hotlinked provider URL (#172) ending in
`/pic123.jpg` would size **our** object of that name and report a stranger's bytes
as this tenant's. A provider cover costs us nothing, so `null` is also the honest
answer.

The route sizes at most `SIZE_SAMPLE_MAX` (500) objects — a tenant at the games
quota would otherwise fire thousands of HeadObjects to render one card — and
reports `{ count, sized, bytes, complete }` so the panel can render a "≥" rather
than a wrong total. An unreadable object is skipped, never guessed.

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
