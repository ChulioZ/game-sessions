# Analysis: production-readiness — local-only → publicly hosted

> Status: **analysis + decision** (issue #40). This document maps the full gap
> between the app as it stands on `main` and a publicly hosted product, makes an
> opinionated recommendation per area, and proposes a phased roadmap plus a list
> of follow-up execution issues. **No feature code ships from #40** — only this
> report. Everything below is grounded in the code as it stands today.
>
> The standing constraints (no auth, local-only, no build step, no DB) are the
> subject of this review, so they are **not** binding here — but every place this
> report recommends breaking one is called out explicitly.
>
> The Legal section is **research, not legal advice**; the Branding section's
> availability checks are a snapshot and are **not** a trademark clearance. Both
> flag where a professional must confirm before anything is committed.

---

## 0. TL;DR

- **Recommend the end-state: multi-tenant SaaS** (public sign-up, many
  independent groups, per-tenant isolation) — because the product's own framing
  is "any group or gaming round" ([`CLAUDE.md`](../CLAUDE.md)), which a
  single-instance deployment can't serve. **But sequence it**: the *first* hosted
  milestone should be a **single authenticated instance** (one group, auth gate,
  real database, TLS) to de-risk auth/DB/ops before multiplying tenants. Same
  destination, safer path.
- **The three hard blockers**, in order: (1) **no authentication or
  authorization** on any route; (2) the **process-local in-memory store** with no
  concurrency safety; (3) **no transport security / production hosting**. Nothing
  public can happen until all three are addressed.
- **Keep the stack, don't rewrite.** Node/Express is fine for production. The
  no-build vanilla frontend is fine for a single instance and *acceptable* for
  multi-tenant with a thin build added later — a framework rewrite is **not** a
  prerequisite and would be the single biggest waste of effort here.
- **The goal is a website *and* native iOS/Android store apps** (per
  `CLAUDE.md`), not just responsive web. Good news: the backend is already
  **API-first** (clean JSON `/api/*` routes), which is the hard prerequisite.
  Recommend reaching the stores by **wrapping the existing web UI with Capacitor**
  (plus a PWA step), **not** a React Native/Flutter rewrite. See §2.4.
- **Data:** move `data/data.json` → **PostgreSQL** (managed). This is
  non-negotiable for more than one concurrent writer or more than one process.
- **Legal (DE/EU):** once hosted for real users, an **Impressum (§ 5 DDG)** and a
  **GDPR/DSGVO privacy policy** are **legal musts**; a cookie-consent banner is
  **probably not required today** because the app sets no non-essential cookies
  (it uses `localStorage` only) — but that needs confirming against the current
  tracking (Anthropic call) and a lawyer's sign-off.
- **Brand:** "Spieleabend" is generic German for "game night" — descriptively
  weak, unregistrable as-is, and already crowded (e.g. the AI organizer
  [Boardy](https://www.boardyboard.com/)). Recommend a distinctive coined name;
  **`rundenwahl`** and **`ludopick`** are both free on `.com`/`.app`/`.de` as of
  this writing. **Avoid anything with "meeple"** — it's an EU/DE trademark.

The rest of this document is the reasoning behind each of these.

---

## 1. The recommendation up front: which end-state?

The issue asks to choose between two destinations, because the choice cascades
into auth, data model, hosting, and legal.

| | **Multi-tenant SaaS** | **Single internet-exposed instance** |
|---|---|---|
| Who it serves | Many independent groups, public sign-up | One group, just reachable from the internet |
| Data model | Every entity scoped to a tenant/account; strict isolation | Today's model, unchanged |
| Auth | Full registration, sessions, roles, password reset | A single shared gate (one password / one small user set) |
| Hosting | Real DB, backups, monitoring, scaling story | One small box + TLS is enough |
| Legal exposure | High — you are a data processor for strangers | Moderate — your own group's data, hosted |
| Effort | High | Low–moderate |

**Recommendation: target multi-tenant SaaS, reached in phases.** The product
description in [`CLAUDE.md`](../CLAUDE.md) — "any group or gaming round to manage
their games" — is a multi-tenant ambition; a single instance can never be that
product, so building only for one group means a second migration later. The
data model is also *closer* to multi-tenant than it looks: a "round" is already a
self-contained unit (its own members, games, sessions, activities — see the
`round` object built in [`routes/rounds.js`](../routes/rounds.js) L69–78), so a
tenant boundary can wrap rounds without reshaping them.

**But the first hosted deployment should be a single authenticated instance.**
It exercises the whole production spine — auth, database, TLS, backups,
monitoring — for one trusted group, where a mistake costs little, before any
stranger's data is involved. Multi-tenancy (accounts, isolation, per-tenant
billing/quotas) is then a *data-model + authz* change layered on a system that
already runs in production. This is the lowest-regret order.

**Rejected: single instance as the end-state.** Cheapest, but it forecloses the
stated product and a second group means a second server — no path to "any group."
Fine only if the ambition quietly shrinks to "just us, but remote."

Everything below assumes **multi-tenant is the destination, single-instance is
milestone one**, and flags where the two diverge.

---

## 2. Architecture & tech stack

### 2.1 Runtime & backend — **keep**

**Current.** Node + Express 5 ([`package.json`](../package.json) — `express
^5.2.1`, `multer ^2.0.0`, `engines.node >=18`). The app is built in
[`lib/app.js`](../lib/app.js) (`createApp()` wires middleware + mounts routers)
and only `server.js` calls `listen()` — a clean split that already lets tests
drive the app in-process. Routers are one-per-resource under `/api/rounds/…`
([`lib/app.js`](../lib/app.js) L21–28), thin and readable.

**Gap.** Nothing structural. Express 5 is current and production-grade. The
per-resource router layout is exactly what scales cleanly to auth middleware and
tenant scoping.

**Recommendation — keep Node/Express.** Add cross-cutting middleware (auth,
`helmet`, rate-limit, request logging) in `createApp()`, never in `server.js`
(tests must keep requiring the app without a port — see
[`.claude/rules/automated-tests.md`](../.claude/rules/automated-tests.md)).

**Rejected: rewrite to Nest/Fastify/etc.** No payoff at this size; throws away a
clean, well-tested codebase. Fastify would buy marginal throughput the app will
never need before a DB is the bottleneck anyway.

### 2.2 Frontend — **keep for now, add a thin build later**

**Current.** Plain classic `<script>`s sharing one global scope, loaded in a
fixed order ([`public/index.html`](../public/index.html)); no build step, no
framework. Assets are root-absolute so deep links work behind the SPA fallback
(see [`.claude/rules/spa-fallback-absolute-asset-paths.md`](../.claude/rules/spa-fallback-absolute-asset-paths.md)),
and fonts are **self-hosted woff2** ([`public/fonts/`](../public/fonts)) — no
Google Fonts CDN, which is a genuine privacy/GDPR win (no third-party font
request leaking IPs).

**Gap.** Three things bite at production scale, none fatal:
1. **No cache-busting.** Static assets ship without content hashes, so a deploy
   can serve stale JS/CSS from browser/CDN caches. Today this is a home-LAN
   non-issue; publicly it causes "hard-refresh to fix" bug reports.
2. **No minification/bundling.** Fine over LAN; over the internet it's more bytes
   and more round-trips than needed (modest — the JS is ~10k LOC total across
   [`public/js/`](../public/js)).
3. **Shared-global-scope fragility.** The load-order trap (documented in
   [`.claude/rules/frontend-script-load-order.md`](../.claude/rules/frontend-script-load-order.md))
   is a maintainability tax that grows with the codebase, not a user-facing bug.

**Recommendation.** For **milestone one (single instance): keep it as-is** — the
constraints that make it fragile also make it dependency-free and easy to reason
about, and it works. For **multi-tenant/public**: add the *smallest possible*
build step whose only jobs are **content-hashed filenames (cache-busting)** and
**minification** — e.g. `esbuild` as a one-command bundle, kept optional so local
dev still runs with no build. This is a deliberate, scoped break of the
"no build step" constraint, justified purely by cache-busting; it is **not** a
license to adopt a framework.

**Rejected: SPA framework rewrite (React/Vue/Svelte).** The single most expensive
option on the table, and it buys nothing the current UI can't already do — the
app is already a working client-side-routed SPA
([`public/js/router.js`](../public/js/router.js)). Defer indefinitely; revisit
only if the frontend's complexity outgrows the shared-scope pattern, which is a
*code-quality* trigger, not a *going-live* one.

### 2.3 Statefulness & scaling — **the real architectural blocker**

**Current.** [`lib/store.js`](../lib/store.js) loads the entire dataset into one
in-memory `data` object **once at require-time** (L36) and rewrites the **whole
file** on every mutation via atomic temp-file+rename (`saveData()`, L40–44).
This is elegant for one process on a LAN and is the single source of truth the
whole backend mutates in place.

**Gap — this does not survive going public:**
- **Single process only.** Two server processes (horizontal scaling, or even a
  rolling deploy with overlap) each hold their own copy of `data`; whoever saves
  last wins and silently clobbers the other — the exact failure mode already
  documented for *external* edits in
  [`.claude/rules/data-json-external-edits.md`](../.claude/rules/data-json-external-edits.md),
  now caused by a second app instance.
- **No concurrency control.** Mutations are last-write-wins over the whole file;
  concurrent writers can lose updates.
- **Rewrite-whole-file cost** grows with total data — fine for one group, wrong
  shape for many tenants.
- **Restarts** are safe (atomic write) but there's no point-in-time recovery.

**Recommendation.** This is resolved by the **data-persistence move to a real
database** (§3), which also makes the backend **stateless** (any number of
processes behind a load balancer, safe rolling deploys). Until the DB lands, the
app **must run as exactly one process** — treat that as a hard operational
constraint of milestone one.

**Rejected: keep the JSON file + a file lock / single-writer queue.** Possible
for a single instance, but it's engineering effort spent propping up a design
you're going to replace anyway, and it still can't scale horizontally.

### 2.4 Delivery: web, PWA, and native iOS/Android apps

**The stated goal is a hosted website *and* an app** ([`CLAUDE.md`](../CLAUDE.md):
"bring this live as a hosted **website and app**"). "App" here means real
**native iOS/Android apps in the App Store and Play Store**, not just a
phone-friendly website — so how the UI is *delivered* is a first-class
architectural question, not an afterthought.

**Current.** One delivery channel: a server-rendered app shell + client-side-
routed SPA served by Express ([`lib/app.js`](../lib/app.js) SPA fallback,
[`public/js/router.js`](../public/js/router.js)). No manifest, no service worker,
no native packaging. It's a website, full stop.

**The one thing already right: the backend is API-first.** Every data operation
is a JSON call under `/api/*` ([`lib/app.js`](../lib/app.js) L21–28), cleanly
separated from the frontend. That is *the* hard prerequisite for native apps —
any client (web, PWA, native shell) talks to the same API. The app does **not**
need a backend rewrite to go native.

**Three delivery options (not mutually exclusive):**

1. **PWA — installable web app.** Add a web app manifest + service worker so the
   existing SPA installs to the home screen and works offline. *Cheapest by far*
   and reuses 100% of the current UI. **Limit:** it is **not** an App Store /
   Play Store listing — Android installs it well, iOS support is partial (limited
   push, no store presence). Good as a first step and a fallback, but it does
   **not** by itself satisfy "an app in the stores."
2. **Capacitor wrapper — RECOMMENDED path to the stores.** Wrap the *existing web
   frontend* in a native shell ([Capacitor](https://capacitorjs.com/)): one thin
   native project per platform loads the same HTML/JS/CSS, and you ship real
   `.ipa`/`.aab` bundles to both stores. Reuses essentially the whole current UI,
   unlocks native APIs (push via APNs/FCM, and **camera/barcode scanning** to add
   games by scanning a box — a feature the competitor
   [Boardy](https://www.boardyboard.com/) already has), and keeps a single UI
   codebase. This is the lowest-effort route from "website" to "store apps" given
   what's already built. Pairs naturally with the thin frontend build in §2.2.
3. **Native / cross-platform rewrite (React Native / Flutter).** Best-in-class
   native UX and performance, but a **second full frontend codebase** to build
   and maintain forever, throwing away the working vanilla SPA. **Rejected**
   unless the UX bar demands truly native feel — which a game-night collection
   manager almost certainly does not.

**Recommendation:** **API-first backend (already true) → PWA (installable, offline)
→ Capacitor wrapper for App Store + Play Store**, in that order. Defer any
RN/Flutter rewrite indefinitely.

**What going native cascades into (carried through the rest of this doc):**
- **Auth (§5):** native apps can't rely on browser cookies the same way — they
  need **token-based auth** (OAuth 2.0 + PKCE, refresh tokens in the platform
  **Keychain/Keystore**). Build the account model token-first so web and native
  share it.
- **Legal & store compliance (§9):** each store adds its own gate on top of DSGVO
  — **Apple App Review** + **Google Play** policies, **privacy nutrition labels /
  Data Safety** declarations, an age rating, a public **privacy-policy URL**, and
  Apple's requirement that **any app offering account creation must offer in-app
  account deletion** (which the API can already do — see the clean delete in
  [`routes/games.js`](../routes/games.js)). Apple/Google become additional
  distributors/processors.
- **Ops/release (§8):** paid developer accounts (**Apple Developer ~$99/yr**,
  **Google Play ~$25 one-time**), app signing, and mobile build/release CI —
  distinct from the web deploy pipeline.
- **Push infrastructure** (APNs/FCM) if notifications are wanted — new, optional.

**Blocker note:** native apps are **not** a launch blocker for the *website*, but
they **depend on** the same spine (auth, API, hosting) — so building that spine
token-first (§5) avoids rework when the apps come. Sequenced in Phase 2/3.

---

## 3. Data persistence

**Current.** `data/data.json` (a JSON tree of rounds → members/games/sessions/
activities) plus cover images as files under `data/uploads/`, with only the path
stored in the JSON ([`lib/store.js`](../lib/store.js),
[`lib/upload.js`](../lib/upload.js)). No schema, no migrations by design
(`CLAUDE.md`), rating averages derived on demand from session votes (not
denormalized).

**Gap.** Everything in §2.3, plus: no backups beyond copying a file, no
concurrent-write safety, no query layer, and uploaded images live on local disk
(lost if the host is ephemeral).

**Recommendation — managed PostgreSQL.**
- **Why Postgres:** relational data with clear entities and relationships (a
  round *has many* games/sessions; a session *has many* votes) maps naturally to
  tables; it's the boring, universally-hosted, strongly-consistent default;
  `JSONB` columns let the messier bits (votes maps, activity payloads) stay
  document-shaped where that's genuinely simpler, so the migration need not
  fully normalize on day one.
- **Schema sketch (multi-tenant):** `tenants` → `users` (accounts) →
  `memberships`; then `rounds (tenant_id)` → `round_members`, `games`,
  `sessions` → `session_votes`, `activities`. Every top-level row carries a
  `tenant_id`; **every query filters on it** (the isolation boundary — see §5/§6).
  Note that today's `members` are *just names* (`{ id, name }`,
  [`routes/rounds.js`](../routes/rounds.js) L60) — decoupled from any account.
  That's actually convenient: "member" (a seat at a round) stays a lightweight
  record and can be *optionally linked* to a real `user` account, so not every
  player needs to sign up.
- **Images:** move `data/uploads/` to **object storage** (S3-compatible) so the
  app tier is stateless; keep the DB storing only the URL/key, exactly as it
  stores the path today.
- **Migration from file data:** a one-off script reads the existing
  `data.json`, inserts rows under a first tenant, and uploads the cover files to
  object storage. This is a genuine one-time migration — consistent with the repo
  stance of migrating once rather than shipping permanent migration code
  (`CLAUDE.md`). Follow
  [`.claude/rules/data-json-external-edits.md`](../.claude/rules/data-json-external-edits.md):
  **stop the server first**, back up the file (it's gitignored).
- **Backups:** managed Postgres gives automated daily backups + PITR out of the
  box — one of the main reasons to pay for managed over self-hosted.

**Rejected alternatives.**
- **SQLite** (e.g. via Litestream) — tempting for a single instance and would be
  a fine *milestone-one* choice, but it doesn't take you to multi-tenant
  horizontal scaling; choosing Postgres once avoids a second migration.
- **A document DB (Mongo)** — the data is relational (votes reference games
  reference rounds); a document store re-creates joins in app code and weakens
  the tenant-isolation guarantees a relational `tenant_id` FK gives you.
- **Keep JSON files** — ruled out in §2.3.

---

## 4. Security

This is the section the "trusted LAN" assumption has been hiding. **Every item
below is currently absent**, because the threat model is "people I trust, on my
network."

**Current state (grounded).**
- **No authentication, no authorization — anywhere.** [`lib/app.js`](../lib/app.js)
  mounts routers with no auth middleware; every route is open. Anyone who can
  reach the port can create/delete rounds
  ([`routes/rounds.js`](../routes/rounds.js) `DELETE /:rid`), delete sessions
  ([`routes/sessions.js`](../routes/sessions.js) `DELETE /:sid`), delete activity
  entries, edit members, etc. On a LAN that's the whole point; on the internet
  it's an open database.
- **No transport security.** `server.js` serves plain HTTP.
- **Input validation is per-route and ad hoc.** It exists and is reasonable
  (e.g. [`routes/games.js`](../routes/games.js) validates title/players/duration;
  [`routes/rounds.js`](../routes/rounds.js) validates name/members), but there's
  no shared schema layer, and error messages are English-only server-side by
  design (`CLAUDE.md`).
- **File upload** ([`lib/upload.js`](../lib/upload.js)): 10 MB limit and a
  `mimetype.startsWith('image/')` filter — but MIME is client-supplied and
  **spoofable**, and the stored extension comes from `originalname`. Files are
  saved under `data/uploads/` and served via `express.static`
  ([`lib/app.js`](../lib/app.js) L18). No content sniffing / re-encoding.
- **SSRF is already handled well** for the one place it matters: cover-image
  downloads go through a **host allowlist** (`isAllowedImageUrl` /
  `imageHostAllowed`, [`routes/games.js`](../routes/games.js) `downloadCover`,
  L35–55; see
  [`.claude/rules/add-game-lookup-provider.md`](../.claude/rules/add-game-lookup-provider.md)).
  This is a real strength — keep it and extend the same discipline anywhere a
  user-supplied URL is fetched.
- **Secrets management** is already sane: `ANTHROPIC_API_KEY` and provider
  locales live in `.env` (gitignored), documented in
  [`.env.example`](../.env.example), never committed
  ([`.claude/rules/no-reading-env-files.md`](../.claude/rules/no-reading-env-files.md)).
- **Supply-chain posture is good:** tiny dependency surface (two runtime deps),
  Dependabot for npm + Actions ([`.github/dependabot.yml`](../.github/dependabot.yml)),
  CI/Lint on every PR. This is *better* than most hobby projects and should be
  preserved.
- **No rate limiting.** The outbound Claude call
  ([`routes/recommendations.js`](../routes/recommendations.js)) is a real
  cost/abuse vector once public (it spends real money per call).

**Gap → what "removing the trusted-LAN assumption" requires:**
1. **AuthN + AuthZ on every route** (§5). Authz must be enforced centrally, not
   sprinkled per-route.
2. **TLS everywhere** (terminate at the host/proxy; HSTS).
3. **`helmet`** for security headers (CSP, `X-Content-Type-Options`, frame
   options, etc.).
4. **Rate limiting** — global, and *stricter* on the money-spending
   recommendations endpoint and any future auth endpoints (brute-force).
5. **Harden uploads** — verify real image content (magic-byte sniff or re-encode
   via `sharp`), derive extension from the detected type not `originalname`,
   consider serving user uploads from a separate origin/object storage to blunt
   any stored-XSS-via-file vector.
6. **Tenant isolation** as an authorization concern: every query scoped to the
   caller's tenant; a missing filter is a data-leak-between-groups bug (§6).
7. **Centralized input validation** — adopt a schema validator (e.g. `zod`) at
   the router boundary so validation is uniform and total, not per-handler.
8. **Structured request logging** without logging secrets or full personal data.

**Recommendation.** Treat 1–4 as **launch blockers** (no public exposure
without them), 5–8 as **fast-follow hardening**. None of this argues for a
rewrite — it's middleware and discipline layered onto the existing clean router
structure.

**Rejected: "put it behind a VPN / Tailscale and call it hosted."** That's just
a nicer LAN — legitimate for *milestone one's* single instance if the group is
fine with it, but it is explicitly **not** a public product and doesn't advance
the roadmap.

---

## 5. User registration & authorization

**Current.** No accounts, no login, no sessions, no roles. "Members" are plain
name strings attached to a round ([`routes/rounds.js`](../routes/rounds.js)
L60) — they identify *a seat at the table*, not *a person who can log in*. This
is the deepest change going public requires.

**Recommendation.**
- **Milestone one (single instance):** the smallest real auth — a single shared
  login (or a tiny fixed user list) gating the whole app. Session cookies
  (`httpOnly`, `Secure`, `SameSite`), server-side sessions or signed JWTs. This
  alone converts "open database on the internet" into "our group's private
  instance."
- **Multi-tenant:** full account model — `users` with email + password
  (Argon2/bcrypt hashing), email verification, password reset, session
  management, and **roles per round/tenant** (owner/editor/viewer). Map roles to
  the mutating routes that are currently open: who may delete a round
  ([`routes/rounds.js`](../routes/rounds.js)), delete/finish a session
  ([`routes/sessions.js`](../routes/sessions.js)), edit members, spend money on
  recommendations.
- **Strongly consider offloading identity to an IdP / OAuth** (Sign in with
  Google/Apple, or a managed auth provider). Rationale: password reset, email
  verification, MFA, breach monitoring, and "don't store password hashes
  yourself" are exactly the parts that are easy to get dangerously wrong, and
  this app has no reason to differentiate on auth. The trade-off is a third-party
  dependency and (for hosted IdPs) cost + a data-processing relationship.
- **Keep "member" decoupled from "user."** Not every player at a game night wants
  an account; the existing name-only member record is the right primitive — allow
  *optionally* linking a member to a user account (for people who log in) while
  letting the rest stay nameless seats. This preserves current UX and eases
  migration.

**Rejected alternatives.**
- **Roll-your-own full password stack** — feasible but concentrates the highest-
  risk security surface in-house for no product benefit; prefer an IdP or a
  vetted library, never hand-rolled crypto.
- **Magic-link-only (passwordless)** — attractive (no password storage) and worth
  considering, but it hard-depends on reliable transactional email and adds
  friction; keep as an option, not the default recommendation.

---

## 6. Multi-tenancy & data isolation

*(Split out from §5 because it's the SaaS-specific risk.)*

**Current.** No tenancy — one dataset, one group.

**Gap.** In multi-tenant SaaS, the **number-one catastrophic bug class is
cross-tenant data leakage**: group A seeing group B's rounds. Today's routers
fetch by id with no ownership check (`findRound(rid)` returns any round —
[`lib/store.js`](../lib/store.js) L48), which is correct now and a vulnerability
the moment there's more than one tenant.

**Recommendation.**
- Add `tenant_id` to every top-level entity; **enforce the filter in one place**
  (a data-access layer or middleware that injects the caller's tenant into every
  query), not per-handler where one forgotten `WHERE` leaks data.
- Consider Postgres **Row-Level Security (RLS)** as defense-in-depth so the
  database itself refuses cross-tenant reads even if app code slips.
- Add tenant-scoped **quotas/limits** (rounds, uploads, recommendation spend) to
  bound abuse and cost.

**Rejected: database-per-tenant.** Strong isolation, but operationally heavy
(migrations × N databases, connection sprawl) at this scale; a single database
with `tenant_id` + RLS is the right weight.

---

## 7. Code quality & maintainability

**Current — genuinely good for the size:**
- **Tests:** 19 spec files ([`test/`](../test)) driving the app in-process via
  `supertest`, each in an isolated temp `DATA_DIR`
  ([`.claude/rules/automated-tests.md`](../.claude/rules/automated-tests.md)),
  including i18n key-parity enforcement
  ([`test/i18n-parity.test.js`](../test/i18n-parity.test.js)) and provider
  parsers tested against sample HTML with no network.
- **CI/CD:** `CI` (test matrix Node 18–26) + `Lint` (eslint + syntax) on every
  push/PR ([`.github/workflows/`](../.github/workflows)); Dependabot weekly.
- **Codified learnings:** a strong [`.claude/rules/`](../.claude/rules) culture
  captures the non-obvious traps — this is a real maintainability asset.

**Gap for production.**
- **No CD.** CI validates but nothing deploys; going live needs a deploy pipeline
  (§8).
- **No coverage measurement.** Tests are broad but coverage is unknown; add
  `c8`/`node --experimental-test-coverage` reporting so gaps (esp. around new
  auth/tenant code) are visible.
- **Observability is absent.** No structured logging, no error tracking (e.g.
  Sentry), no health/readiness endpoint, no metrics. A public service needs at
  minimum: a `/healthz` endpoint, structured request logs, and error alerting.
- **Error handling is per-route** and mostly returns JSON `{ error }` with a
  status; there's no central Express error handler or 500 catch-all — add one so
  unexpected throws don't leak stack traces and are logged/alerted.
- **Frontend fragility** (§2.2) is the main structural debt; contained today by
  the rules files but real.

**Recommendation.** Add coverage reporting, a central error handler, a health
endpoint, structured logging, and an error-tracking integration. These are small,
independently shippable, and become load-bearing the moment real users hit the
app.

---

## 8. Hosting & operations

**Current.** `npm start` → `node server.js` on `:3000`, plain HTTP, local disk
for data + uploads ([`server.js`](../server.js)). No container, no deploy
pipeline, no TLS, no monitoring.

**Recommendation.**
- **Containerize** (a small `Dockerfile`, `node:22-slim`) so the runtime is
  reproducible and host-agnostic. This also formalizes config-via-env, which the
  app already leans on (`PORT`, `DATA_DIR`, `ANTHROPIC_API_KEY`,
  [`.env.example`](../.env.example)).
- **Host:** a managed container/app platform (Fly.io, Render, Railway) or a small
  VPS + reverse proxy (Caddy/Traefik for automatic TLS). Pair with **managed
  Postgres** (§3) and **object storage** for uploads so the app tier is stateless.
- **TLS:** terminate at the platform/proxy; enable HSTS.
- **Deploy pipeline:** extend the existing GitHub Actions — on merge to `main`,
  build the image and deploy. CI already gates merges, so CD is an add-on, not a
  rebuild.
- **Backups/monitoring:** managed Postgres backups + PITR; uptime check on
  `/healthz`; error tracking (§7); log aggregation.
- **Cost envelope (rough, EUR/month):** small managed Postgres ~€15–25, app
  hosting ~€5–20, object storage ~€1–5, domain ~€1, error tracking free tier →
  **on the order of €25–50/month** for a low-traffic launch, before any
  Anthropic API usage (which is pay-per-use and user-triggered). This is a
  hobby-scale bill, not a blocker.

**Rejected: self-hosting Postgres / rolling your own TLS / a Kubernetes setup.**
All add operational burden with no benefit at this scale; managed services are
strictly the better trade here.

---

## 9. Legal & compliance (DE/EU)

> **Research, not legal advice.** German/EU rules are fact-specific; a lawyer
> must confirm before launch. The point here is to separate the clear **musts**
> from the **nice-to-haves** and flag where professional review is required.

Assume German UI, German/EU users, and (for the SaaS end-state) that you host
**strangers'** personal data — which is the line that turns most of this from
optional to mandatory.

### 9.1 Impressum — **legal must (once non-private)**

- The Impressum obligation moved from **§ 5 TMG to § 5 DDG** (Digitale-Dienste-
  Gesetz) effective **14 May 2025** — any Impressum/legal text must reference
  **DDG**, not TMG.
- A **purely private** site for friends/family generally needs no Impressum — so
  *milestone one* (your own group, gated) may fall under the private exception.
- The moment the service is **public / offered to others** (multi-tenant
  sign-up), it is no longer "purely private" and an Impressum is **required**;
  omitting or mislabeling it is an *Ordnungswidrigkeit* with fines cited up to
  €50,000 in the worst case.
- **Confirm with a lawyer:** whether the specific launch shape counts as private,
  and exactly what the Impressum must contain (note: a *private individual*
  publishing an Impressum then exposes their **home address**, which is itself a
  reason many hobby projects incorporate or use a service address — a real
  decision, not a formality).

### 9.2 GDPR/DSGVO — **legal must (once hosting real users' data)**

- The app stores **personal data**: member names (real names are personal data),
  ratings/opinions tied to people, and — once accounts exist — emails. Server
  logs will contain **IP addresses** (personal data). This triggers the full
  GDPR stack: a **privacy policy (Datenschutzerklärung)**, a **lawful basis** for
  each processing purpose, **data-subject rights** (access/export/deletion —
  note the app already deletes cleanly: retired-game deletion scrubs sessions and
  activities, [`routes/games.js`](../routes/games.js) `DELETE`), **data
  minimization**, and **retention** limits.
- **Third-party processors** need **Data Processing Agreements**:
  - **Your host + managed DB + object storage** (each a processor).
  - **Anthropic** — the buy-next feature makes an **outbound call to the Claude
    API** ([`routes/recommendations.js`](../routes/recommendations.js)). The
    payload is deliberately an **aggregated, member-anonymous taste profile**
    (the route's own doc-comment and design,
    [`docs/recommendations-analysis.md`](./recommendations-analysis.md)), which
    materially lowers exposure — but it is still a **US transfer** and must be
    covered by Anthropic's DPA/SCCs and disclosed in the privacy policy. **Keep
    the anonymization**; it's a privacy feature, not just a nicety.
- **Confirm with a lawyer/DPO:** lawful basis (consent vs. legitimate interest vs.
  contract) per purpose, retention periods, whether a **DPIA** is needed, and the
  international-transfer basis for the Anthropic call.

### 9.3 Cookie / consent banner — **probably NOT required today (verify)**

- German cookie/consent law lives in **§ 25 TDDDG** (the renamed TTDSG). It
  requires consent for storing/reading information on the user's device **unless
  strictly necessary** for a service the user requested.
- **The app currently sets no cookies and uses `localStorage` only** — e.g. the
  locale preference ([`public/js/i18n.js`](../public/js/i18n.js)) and lookup
  state. `localStorage` used for **strictly necessary** app function (remembering
  the chosen language, an auth session token) generally falls under the
  necessity exception, so **a consent banner is likely not required** as things
  stand — a real advantage of the current no-tracking design. Fonts are
  self-hosted (§2.2), so there's no Google-Fonts consent issue either.
- **This changes** if you add **analytics, ad, or other non-essential tracking**,
  or if the auth solution sets non-essential cookies — then a compliant consent
  mechanism becomes a **must**.
- **Confirm with a lawyer:** that the Anthropic call and any auth cookies qualify
  as "strictly necessary," and re-check the moment analytics is considered.

### 9.4 Terms of Service — **nice-to-have → must for SaaS**

A single private instance can skip ToS; a public multi-tenant service offering
accounts to strangers should have **Terms of Service / AGB** (acceptable use,
liability limits, account termination). Lawyer-drafted for launch.

---

## 10. Branding, name & domain

> Availability is a **snapshot** (checked via authoritative RDAP: Verisign for
> `.com`, DENIC for `.de`, registry bootstrap via `rdap.org` for `.app`) and is
> **not a trademark clearance**. A DPMA (German) + EUIPO (EU) register search in
> the relevant Nice classes, by an attorney, is required before committing.

**Current brand.** "Spieleabend" (`app.title`, `<title>`) is **generic German
for "game night."** As a trademark it is **descriptive → not distinctive →
effectively unregistrable and unenforceable**, and the space is crowded (e.g.
the AI game-night organizer [Boardy](https://www.boardyboard.com/) is a direct
adjacent product). It's a fine *internal* name; it is a weak *brand*. Note
`CLAUDE.md` already treats "Spieleabend" as the product name and the entity as
"Session," so a rebrand touches `app.title`/`<title>` and marketing copy, not the
domain model.

**What makes a good pick here:** a **coined / distinctive** word (inherently
registrable), short, pronounceable in German *and* English (the app is DE-first
but EN-parity), with `.com` **and** `.de` **and** `.app` free.

**Shortlist (RDAP snapshot — all three TLDs shown; `avail` = not registered):**

| Candidate | Meaning / angle | `.com` | `.app` | `.de` | Notes |
|---|---|---|---|---|---|
| **`rundenwahl`** | DE "the round's choice" — ties to the app's core "Runde" + voting | avail | avail | avail | **Top pick.** On-brand for a German-first product, distinctive, all TLDs free. Slightly descriptive in German → get an attorney read on distinctiveness. |
| **`ludopick`** | "ludo" (play) + "pick" — international, coined | avail | avail | avail | **Top pick.** Language-neutral, clearly coined (strong mark), all TLDs free. |
| `ludoround` | "ludo" + "round" | avail | avail | avail | Solid backup; a touch generic. |
| `spielwahl` | DE "game choice" | avail | avail | avail | Descriptive in German (weaker mark), like `rundenwahl` but less tied to the app's "Runde" identity. |
| ~~`meeplevote`~~ | meeple + vote | avail | avail | avail | **Avoid.** Domains are free but **"meeple" is a registered EU/DE trademark** (Hans im Glück / Carcassonne) — real conflict risk for a DE/EU product. Good example of *why domain-free ≠ safe*. |

**Recommendation.** Lead with **`rundenwahl`** (fits the German-first, round-
centric product) or **`ludopick`** (if a language-neutral, more obviously
"coined" mark is preferred for international reach and stronger trademark
footing). Both are free on `.com`/`.app`/`.de` right now. **Register the domain
set early** (they go fast) but **do the attorney trademark clearance
(DPMA + EUIPO, classes 9 software / 41 entertainment / 42 SaaS) before spending
on brand assets.**

**Rejected: keep "Spieleabend" as the public brand.** Unregistrable, undifferen-
tiated, and SEO-invisible against the generic term. Fine to keep as a friendly
subtitle; not the brand to build on.

---

## 11. Internationalization & product readiness

**Current.** Solid i18n foundation: DE/EN with enforced key parity
([`public/js/lang/`](../public/js/lang), tested by
[`test/i18n-parity.test.js`](../test/i18n-parity.test.js)); locale follows system
language, overridable, persisted in `localStorage`
([`public/js/i18n.js`](../public/js/i18n.js)). This is *ahead* of most hobby
projects and a real launch asset.

**Gap for a public launch (product, not i18n plumbing):**
- **Onboarding / empty states** — the app assumes you already have a round; a
  public first-run needs a sign-up → create-first-round → invite flow.
- **Invitations** — multi-tenant needs a way to invite people to a round
  (email/link), which doesn't exist (members are added as names).
- **Accessibility** — no evidence of an a11y pass (focus management, ARIA,
  contrast — the theme system is color-mix-derived per
  [`.claude/rules/theme-derived-colors.md`](../.claude/rules/theme-derived-colors.md),
  which helps but isn't a guarantee). A public product should run an a11y audit.
- **Mobile web** — verify the responsive story holds for a public audience on
  phones (the app is used on a couch; mobile is likely the primary device). This
  is *separate from* the **native iOS/Android apps** the product also targets —
  the delivery strategy for those (PWA → Capacitor) is covered in **§2.4**.
- **Legal surfaces in-product** — Impressum/privacy links in the footer (§9).

**Recommendation.** None of these block *milestone one* (your group already knows
how to use it). They are **multi-tenant launch** requirements: build onboarding +
invitations alongside the account model (§5), and run a11y + mobile audits before
public sign-up opens.

---

## 12. Phased roadmap

Effort: **S** ≈ hours–1 day · **M** ≈ days · **L** ≈ 1–2 weeks · **XL** ≈ weeks.
Risk = chance of getting it subtly wrong / blast radius.

### Phase 0 — Decide & prepare (no user impact)
| Item | Effort | Risk | Notes |
|---|---|---|---|
| Confirm end-state (multi-tenant SaaS) & this roadmap | S | Low | The decision this doc recommends. |
| Attorney: trademark clearance for chosen name | S (external) | Med | **Blocker for brand spend**, not for code. |
| Register domain set (`.com`/`.app`/`.de`) | S | Low | Do early; cheap; reversible-ish. |

### Phase 1 — Milestone one: single authenticated instance 🔒 *(the going-live spine)*
| Item | Effort | Risk | Blocker? |
|---|---|---|---|
| **Move to PostgreSQL** + object storage for uploads; one-time file→DB migration | **L** | **High** | **HARD BLOCKER** (§3, §2.3) |
| Make backend **stateless / single-writer-safe** (falls out of DB move) | M | High | HARD BLOCKER |
| **Auth gate** (single shared/small-user login, session cookies) | M | High | **HARD BLOCKER** (§5) |
| **TLS + `helmet` + rate limiting** | S–M | Med | **HARD BLOCKER** (§4) |
| **Containerize + deploy pipeline + managed host** | M | Med | **HARD BLOCKER** (§8) |
| Central error handler, `/healthz`, structured logging, error tracking | M | Low | Strongly recommended before public |
| Harden file uploads (content sniff/re-encode, safe extension) | S–M | Med | Fast-follow |
| Impressum + privacy policy (lawyer-reviewed) | S (+external) | Med | Required if not "purely private" (§9) |

*Exit:* your group's data runs in the cloud, gated, on TLS, on a real DB, with
backups and monitoring — nothing public yet.

### Phase 2 — Multi-tenant SaaS
| Item | Effort | Risk | Blocker? |
|---|---|---|---|
| Account model (users, email verify, password reset **or IdP/OAuth**) — build **token-first** so native apps share it (§2.4/§5) | **L** | **High** | Blocker for public sign-up (§5) |
| **Tenant model + isolation** (`tenant_id` everywhere, central enforcement, RLS) | **L** | **Very High** | Blocker — cross-tenant leak is catastrophic (§6) |
| Roles/permissions mapped to mutating routes | M | Med | Blocker |
| Invitations (link/email) + onboarding / empty states | M–L | Med | Blocker for usable sign-up (§11) |
| Per-tenant quotas (esp. recommendation spend) | S–M | Med | Cost/abuse control |
| Terms of Service / AGB, DPAs (host, DB, Anthropic), transfer basis | S (+external) | Med | Legal must for SaaS (§9) |
| Consent mechanism **iff** non-essential tracking is added | S | Low | Conditional (§9.3) |

### Phase 3 — Native apps, scale & polish (as needed)
| Item | Effort | Risk |
|---|---|---|
| Thin frontend build (content-hash cache-busting + minify, `esbuild`) | S–M | Low |
| **PWA** — manifest + service worker, installable + offline (§2.4) | M | Low |
| **Capacitor wrapper** → App Store + Play Store apps; push + barcode scan (§2.4) | **L** | Med |
| **App-store compliance & mobile release pipeline** — dev accounts, signing, privacy labels, in-app account deletion, mobile CI (§2.4/§9) | M | Med |
| Horizontal scaling (multi-process behind LB — enabled by stateless tier) | M | Med |
| Accessibility audit + mobile-web responsiveness pass | M | Low |
| Coverage reporting + broaden tests around auth/tenant code | M | Low |
| Localize server-side error messages if user-facing surfaces grow | S | Low |

**Hard blockers, consolidated (nothing public until all are done):** real
database + stateless tier (§3/§2.3), authentication (§5), TLS + security headers
+ rate limiting (§4), production hosting + deploy (§8); **and for public
multi-tenant specifically**, tenant isolation (§6) and accounts (§5).

---

## 13. Proposed follow-up execution issues (not filed)

Per the issue's deliverable — a directly actionable backlog. Titles + one-line
scope; **not filed as part of #40.**

**Phase 1 — going-live spine**
1. **Migrate persistence from `data.json` to PostgreSQL** — schema, data-access
   layer, one-off file→DB migration script, backups. *(depends on nothing; blocks
   everything)*
2. **Move cover uploads to object storage** — S3-compatible; store key not path;
   make the app tier stateless.
3. **Add an authentication gate (single-instance)** — login, session cookies,
   protect all routes; foundation for accounts later.
4. **Add TLS, `helmet`, and rate limiting** — security headers, HSTS, global +
   per-endpoint limits (esp. recommendations).
5. **Containerize + CD pipeline** — `Dockerfile`, env config, deploy-on-merge via
   Actions, managed host + managed Postgres.
6. **Add observability baseline** — central Express error handler, `/healthz`,
   structured request logging, error tracking.
7. **Harden image uploads** — content-sniff/re-encode, derive extension from
   detected type, isolate served origin.
8. **Publish Impressum + privacy policy** — DDG-compliant Impressum, DSGVO
   privacy policy, in-product footer links (lawyer-reviewed).

**Phase 2 — multi-tenant SaaS**
9. **User account model** — registration, email verification, password reset (or
   integrate an IdP/OAuth).
10. **Tenant model + isolation** — `tenant_id` on all entities, central query
    scoping, Postgres RLS as defense-in-depth.
11. **Roles & permissions** — owner/editor/viewer mapped to mutating routes.
12. **Invitations & onboarding** — invite-by-link/email, first-run sign-up →
    create-round → invite flow, empty states.
13. **Per-tenant quotas & abuse controls** — bound rounds/uploads/recommendation
    spend per tenant.
14. **SaaS legal pack** — ToS/AGB, DPAs (host, DB, Anthropic), international-
    transfer basis, retention policy (lawyer-reviewed).

**Phase 3 — native apps, scale & polish**
15. **Thin frontend build for cache-busting** — `esbuild` bundle with
    content-hashed filenames + minification; keep build optional for local dev.
16. **PWA: installable, offline-capable web app** — web app manifest + service
    worker so the SPA installs to the home screen and works offline (§2.4).
17. **Native iOS/Android apps via Capacitor** — wrap the existing web UI in a
    native shell, ship to App Store + Play Store; unlock push (APNs/FCM) and
    camera/barcode scanning (§2.4).
18. **App-store compliance & mobile release pipeline** — Apple/Google developer
    accounts, app signing, privacy nutrition labels / Data Safety, in-app account
    deletion, mobile build/release CI (§2.4/§9).
19. **Accessibility & mobile-web audit** — a11y pass (focus/ARIA/contrast) and
    mobile-web responsiveness verification.
20. **Test coverage reporting** — add coverage, close gaps around auth/tenant
    code.
21. **Trademark clearance & rebrand** — attorney DPMA/EUIPO search for the chosen
    name (`rundenwahl` / `ludopick`), then swap `app.title`/`<title>` + marketing
    copy.

---

## 14. Summary

The codebase is **well-built for what it is** — clean router split, isolated
tests, tiny dependency surface, self-hosted fonts, a real SSRF allowlist, secrets
in `.env`, enforced i18n parity, and a strong `.claude/rules/` knowledge base.
None of that needs throwing away, and **no rewrite is warranted**. Going public is
not an architecture problem; it's an **operations, security, and data-model**
problem, concentrated in four hard blockers: **a real database + stateless tier,
authentication, transport/edge security, and production hosting**. Clear those as
a **single authenticated instance** first, then layer **accounts + tenant
isolation** to reach the recommended **multi-tenant SaaS** end-state. The product
also targets **native iOS/Android apps**, not just a website — and the backend's
API-first shape already makes that cheap: reach the stores by **wrapping the
existing web UI with Capacitor** (after a PWA step), not a native rewrite, and
build auth **token-first** so web and native share it. The legal
work (Impressum under DDG, DSGVO privacy policy) is a real must once strangers'
data is hosted, but the app's no-tracking, self-hosted-fonts, `localStorage`-only
design means it likely **needs no cookie banner** — a head start most projects
don't have. Pick a distinctive brand (**`rundenwahl`** or **`ludopick`**, domains
free today) and get an attorney's trademark clearance before spending on it.
