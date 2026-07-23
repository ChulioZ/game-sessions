# Grant-based round access (#207): a grantee ACTS AS the owner tenant — RLS stays un-widened

Round sharing (#207) lets a second account act on a round they don't own, via a
row in the global `round_grants` store (`{ roundId, ownerTenantId, userId,
memberId, role }`, absent from `TENANT_METHODS` — a grant is cross-tenant by
nature, see `.claude/rules/postgres-backend.md`/`tenancy-rls.md`). The access is
resolved in **one place** and the mechanism is easy to break or mis-copy.

## The mechanism (`resolveRoundGrant`, lib/tenant.js)

`withTenant` sets `req.tenantId`/`req.repo` to the **caller's own** tenant, plus
`req.userId` (the account id — set only for a real, non-suspended account; a
missing/invalid token leaves it undefined). Then `resolveRoundGrant`, mounted at
**`/api/rounds/:rid`** (in `lib/app.js`, AFTER `withTenant`, BEFORE every round
router), does the re-scope: if the caller holds a grant on **this** `:rid`, it
sets `req.repo = repo.forTenant(grant.ownerTenantId)` and `req.tenantId =
ownerTenantId`. No grant → left untouched (own tenant).

**Why re-scope instead of widening RLS.** A grantee's request then runs with
`app.tenant_id = the OWNER`, i.e. the grantee *acts as the owner tenant* for that
request. So the RLS policies need **no change at all** — this is the same
discipline `admin-moderation-surface.md` §2 prescribes (widen by running under
the owning tenant, never by OR-ing the tenant policy, which silently permits
cross-tenant `DELETE`). Do **not** "simplify" this into a user-keyed RLS predicate
or an OR into the tenant policy.

## Four things that are load-bearing

1. **Mount order and path.** `app.use('/api/rounds/:rid', resolveRoundGrant)`
   sits between `withTenant` and `app.use('/api/rounds', …)` + the nested
   `/api/rounds/:rid/*` routers. It must run **before** any handler touches
   `req.repo`. It matches `/api/rounds/:rid` and everything under it, but **not**
   `/api/rounds` itself — so `POST /api/rounds` (create) is never re-scoped and a
   grantee creates rounds in their **own** tenant. Move it after the routers, or
   broaden it to `/api/rounds`, and you either miss the re-scope or hijack create.

2. **The re-scope is keyed on THIS round's id**, so access is limited to exactly
   the granted round — not the owner's whole tenant. A request for **another** of
   the owner's rounds finds no matching grant, keeps the caller's own-tenant
   `req.repo`, and 404s. If you ever re-scope on "the caller holds *any* grant in
   this tenant" instead of "a grant on *this* rid", a grantee can reach every
   round the owner has. (Corollary: no `/api/rounds/:rid/*` handler may enumerate
   the tenant's *other* rounds through `req.repo` — none do today; `moveGames`
   takes a client-supplied target and fails closed when it isn't in the tenant.)

3. **A grant is not authority to DELETE the round.** `req.grant` is left set so
   `DELETE /api/rounds/:rid` can refuse a grantee (`403 not_owner`). A grant lets
   you act *within* a round, never destroy the owner's whole round + its history.
   Per-action roles are #137; deleting is the one clear owner-only line drawn now.

4. **`req.userId` gates the whole thing.** Legacy mode (accounts off) and
   unauthenticated callers have no `req.userId`, so `resolveRoundGrant` is a
   no-op and today's single-tenant production is byte-for-byte unchanged. The
   feature is also **inert until a grant exists** — there is no grant-creation
   route yet (invitation accept, a later slice of #207, calls `createGrant` +
   `createMember`).

## Verifying a change here

Isolation is the whole point, so test it end-to-end over HTTP with a **seeded**
grant (no creation route yet): `test/round-grants-access.test.js` proves a
grantee reads+writes exactly the granted round, cannot reach another of the
owner's rounds (404), cannot delete it (403), and that the round never leaks into
the grantee's `GET /api/rounds` list (home-merge is a **later** slice — grantees
can't yet *see* shared rounds on their home). The re-scope adds no new SQL — it
composes `listGrantsForUser` + `forTenant`, both already proven on Postgres — and
the app-layer tenant filter behaves identically on both backends, so the JSON
HTTP test's guarantee transfers; the RLS backstop is proven separately as a plain
role in `test/repo.postgres.test.js`.

**Related:** `.claude/rules/tenancy-rls.md` (which pointed here — grants are the
sharing model it deferred), `.claude/rules/admin-moderation-surface.md` §2 (the
"run under the owning tenant, never widen the policy" discipline this follows),
`.claude/rules/postgres-backend.md` (why `round_grants` is a global store).
