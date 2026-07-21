# Production readiness: status, decisions & roadmap

> Originated as issue #40's gap analysis for "local-only → publicly hosted."
> Phases 1 and 2 below (the hard blockers) have since **shipped** — this doc is
> now the living record of what was decided and why, kept current as work
> lands, not a one-off report. Sections describing already-shipped work are
> deliberately short **pointers to the code / `.claude/rules/` file that now
> owns the operative detail** — read those, not this doc, for how something
> works today. Sections describing still-open decisions (legal, branding,
> Phase 1.5 hardening) stay in full, since nothing else captures that
> reasoning yet.
>
> The Legal section (§9) is **research, not legal advice**; the Branding
> section's (§10) domain-availability checks are a snapshot, **not** a
> trademark clearance. Both flag where a professional must confirm before
> anything is committed.

---

## 0. TL;DR

- **End-state: multi-tenant SaaS** (public sign-up, many independent groups,
  per-tenant isolation) — because the product's own framing is "any group or
  gaming round" ([`CLAUDE.md`](../CLAUDE.md)), which a single-instance
  deployment can't serve. **Sequenced through a single authenticated instance
  first** (one group, auth gate, real database, TLS) to de-risk auth/DB/ops
  before multiplying tenants — same destination, safer path.
- **The three hard blockers — all shipped (2026-07-19):** (1) authentication +
  authorization on every route, (2) a real database replacing the
  process-local in-memory store, (3) transport security + production hosting
  (#127–#133, live on Railway — §12 Phase 1). What remains before opening
  **public** sign-up is the legal pack (Impressum #134, blocked externally;
  ToS/DPAs #140); per-tenant quotas (#139) shipped 2026-07-19 — see §12.
- **Kept the stack, no rewrite.** Node/Express, the no-build vanilla frontend,
  and hand-rolled-but-tested logic all proved out in production — see §2.
- **The goal is a website *and* native iOS/Android store apps**, not just
  responsive web. The PWA step shipped (#142); reaching the app stores is
  **Capacitor wrapping the existing web UI**, not a rewrite — still open, see
  §2.4.
- **Data lives in managed PostgreSQL** (§3) with S3-compatible object storage
  for cover images — both shipped, both non-negotiable once there's more than
  one concurrent writer or process.
- **Legal (DE/EU):** once hosting real users, an **Impressum (§ 5 DDG)** and a
  **GDPR/DSGVO privacy policy** are legal musts (§9) — **implemented (#134)**:
  `/impressum` + `/datenschutz` are server-rendered from the `IMPRESSUM_*` env
  identity and stay 404 until it is configured at go-live (#219). A
  cookie-consent banner is **not required today** (no non-essential cookies,
  `localStorage`-only, § 25 Abs. 2 TDDDG); re-check if that ever changes.
- **Brand:** "Spieleabend" is generic German for "game night" — descriptively
  weak and unregistrable as-is (§10). No rebrand has happened; still an open
  decision, not blocking anything already shipped.

The rest of this document is the reasoning behind each of these, and the
current status of what's still open.

---

## 1. Which end-state? — decided

**Decided and executed: target multi-tenant SaaS, reached in phases.** A
single-instance-only product could never serve "any group," so building only
for one group would mean a second migration later. The data model was already
close to multi-tenant: a "round" was already a self-contained unit (its own
members, games, sessions, activities), so the tenant boundary (§6) wrapped
rounds without reshaping them.

| | **Multi-tenant SaaS** (the destination) | **Single instance** (milestone one) |
|---|---|---|
| Who it serves | Many independent groups, public sign-up | One group, reachable from the internet |
| Auth | Full registration, roles, password reset | A single shared gate |
| Legal exposure | High — data processor for strangers | Moderate — your own group's data, hosted |

**Rejected, as planned: single instance as the permanent end-state.** Cheapest,
but forecloses the stated "any group" product.

---

## 2. Architecture & tech stack

### 2.1 Runtime & backend — kept, as decided

Node + Express 5 stayed the runtime; `server.js` only calls `listen()`,
`lib/app.js`'s `createApp()` wires everything else, which is exactly what let
auth, `helmet`, and rate-limit middleware slot in later without restructuring.
**Rejected, as planned:** a Nest/Fastify rewrite — no payoff at this size.

### 2.2 Frontend — kept, thin build shipped

**Decision (still binding — cross-referenced from [`CLAUDE.md`](../CLAUDE.md)):
no SPA framework.** The app is already a working client-side-routed SPA
([`public/js/router.js`](../public/js/router.js)); a framework rewrite buys
nothing it can't already do. The one real risk — shared-global-scope
load-order fragility — is a maintainability tax contained by
[`.claude/rules/frontend-script-load-order.md`](../.claude/rules/frontend-script-load-order.md),
not a production-safety issue.

**Shipped since this call was made:** the cache-busting + minification gap
this section originally flagged is closed. `npm run build` (issue #141, see
[`.claude/rules/frontend-build-cache-busting.md`](../.claude/rules/frontend-build-cache-busting.md))
content-hashes and minifies `public/js/**` + `styles.css` into `dist/`, served
only under `NODE_ENV=production`. It stays a one-command, optional,
non-bundling step (`minifyIdentifiers: false`, never `esbuild.build`/bundling)
— not a license to grow it into a framework or add a build step elsewhere.

**Rejected, still rejected: SPA framework rewrite (React/Vue/Svelte).** Defer
indefinitely; revisit only if the shared-scope pattern's complexity outgrows
what it can hold — a code-quality trigger, not a going-live one.

### 2.3 Statefulness & scaling — resolved

Was the real architectural blocker: `lib/store.js` held the whole dataset in
one in-memory object, unsafe the moment more than one process touched it
(rolling deploys, horizontal scaling). **Resolved by the Postgres backend**
(§3, shipped #127) — the app is stateless once `DATABASE_URL` + `S3_BUCKET`
are set, so any number of processes can run behind a load balancer with safe
rolling deploys. Running more than one process isn't done yet (not needed at
current traffic) — see the rate-limit-store caveat in §7 item 5 (#215) before
it is.

### 2.4 Delivery: web, PWA, and native iOS/Android apps

The stated goal is a hosted website **and** native store apps, not just
responsive web — so delivery is a first-class question. The backend is
API-first (every operation a JSON call under `/api/*`), the hard prerequisite
for any native client; no backend rewrite is needed to go native.

**Status:**
- **PWA — shipped** (#142, see
  [`.claude/rules/pwa-service-worker.md`](../.claude/rules/pwa-service-worker.md)):
  manifest + service worker, installable, offline app shell, reusing 100% of
  the existing UI. Not itself an App Store / Play Store listing (Android
  installs it well; iOS support is partial).
- **Capacitor wrapper → App Store + Play Store — not started, still the
  recommended path.** Wrap the *existing web frontend* in a native shell (one
  thin native project per platform loading the same HTML/JS/CSS); unlocks push
  (APNs/FCM) and camera/barcode scanning; ships real `.ipa`/`.aab` bundles.
  Lowest-effort route to the stores given what's built.
- **Native/cross-platform rewrite (React Native/Flutter) — rejected,** as
  planned: a second full frontend codebase to build and maintain forever, not
  warranted for this UX.

**What going native still cascades into, when picked up (Phase 3):**
- Auth is already token-first (#135), so web and native can share it without
  rework.
- Store compliance: Apple App Review + Google Play policies, privacy nutrition
  labels/Data Safety, an age rating, a public privacy-policy URL, and (per
  Apple) in-app account deletion — the API already supports a clean delete.
- Paid developer accounts (Apple ~$99/yr, Google ~$25 one-time), app signing,
  mobile release CI — a pipeline separate from the web deploy.
- Push infrastructure (APNs/FCM), if wanted — new, optional.

---

## 3. Data persistence — shipped

**Decision executed:** managed **PostgreSQL** (#127) is the production
backend, selected via `DATABASE_URL`; the default JSON-file backend
(`data/data.json`) remains for local/self-hosted use, and both satisfy the
same contract (see
[`.claude/rules/data-access-layer.md`](../.claude/rules/data-access-layer.md),
[`.claude/rules/postgres-backend.md`](../.claude/rules/postgres-backend.md)).
Cover images moved to S3-compatible object storage (#128, see
[`.claude/rules/cover-image-storage-backend.md`](../.claude/rules/cover-image-storage-backend.md))
so the app tier is stateless. Managed Postgres gives automated backups +
point-in-time recovery for free.

**Why Postgres, over the rejected alternatives — still the right call:**
relational data (round → games/sessions → votes) maps naturally to tables,
with `JSONB` for the messier bits (votes maps, activity payloads), so the
migration didn't need to fully normalize on day one. **SQLite** would have
been fine for a single instance but not multi-tenant horizontal scaling,
forcing a second migration later; a **document DB (Mongo)** would have
re-created joins in app code and weakened the tenant-isolation guarantees a
relational `tenant_id` FK gives for free.

---

## 4. Security — hard blockers shipped, hardening ongoing

**Shipped:** authentication + authorization on every route (shared-password
gate #129; token-first accounts #135; tenant-scoped authorization #136, see
[`.claude/rules/tenancy-rls.md`](../.claude/rules/tenancy-rls.md)); TLS
(terminated at Railway's edge, #156); `helmet` security headers +
`express-rate-limit` (#130, see
[`.claude/rules/security-middleware.md`](../.claude/rules/security-middleware.md));
hardened uploads — content-sniff/re-encode, safe extension derived from the
detected type, not `originalname` (#133).

**Already strong, kept:** the cover-image host allowlist (see
[`.claude/rules/add-game-lookup-provider.md`](../.claude/rules/add-game-lookup-provider.md))
— since #172 it gates what may be *stored and hotlinked* rather than downloaded,
and the server no longer fetches cover bytes at all (see
[`.claude/rules/provider-cover-hotlinking.md`](../.claude/rules/provider-cover-hotlinking.md))
and `.env`-only secrets management (see
[`.claude/rules/no-reading-env-files.md`](../.claude/rules/no-reading-env-files.md))
— extend the same discipline to any new user-supplied-URL fetch.

**Still open (fast-follow hardening, not launch blockers — tracked in §7):**
- **Centralized request validation — shipped (#213).** The mutating routers
  (`rounds`, `games`, `sessions`, `account`) now validate request bodies via
  `zod` schemas through a shared `lib/validate.js` helper, replacing the
  per-handler `typeof`/`Array.isArray` checks. (Genuinely stateful checks that
  reconcile against stored data — the game-edit min/max range, session
  round-membership filters — stay in the handlers by design; they aren't
  body-shape validation.)
- **Real error tracking** — the logging engine is now `pino`/`pino-http`
  (**#212 shipped**, same log shape/fields, no-PII request allowlist
  preserved); what remains hand-rolled is only the *error-tracking* stand-in:
  `captureError`'s `ERROR_WEBHOOK_URL` forward. Choosing a real provider (e.g.
  Sentry) is a later, separate decision (cost/DPA implications, §9).
- **Rate-limit store** — `express-rate-limit`'s in-memory store only works
  correctly for one process; fine today (single Railway instance), tracked as
  a prerequisite for horizontal scaling as **#215**.

---

## 5. User registration & authorization — shipped

**Both milestone-one (single shared gate) and the full account model
shipped.** `AUTH_PASSWORD` gates a single shared login (#129); the
token-first account model — email + password (Argon2id), email verification,
access/refresh tokens, password reset (#135, see
[`.claude/rules/user-accounts.md`](../.claude/rules/user-accounts.md)) — runs
alongside it behind `ACCOUNTS_ENABLED`, staged for opening public registration
(see [`.claude/rules/accounts-mode-gate.md`](../.claude/rules/accounts-mode-gate.md)).
"Member" stayed decoupled from "user" as recommended — a name-only seat at a
round, optionally nothing more — which is what let a single-owner tenant
launch without building roles or invitations first (see §6, Phase 4).

**Rejected, as planned:** a full home-grown password stack beyond the hashing
itself (would concentrate high-risk surface for no product benefit) and
passwordless-only login (hard-depends on reliable transactional email).
Offloading identity to an IdP/OAuth was considered and **deferred, not
rejected** — revisit if maintaining the hand-rolled token issuance
(`lib/accounts.js`) becomes a burden; tracked as **#214** (§7).

---

## 6. Multi-tenancy & data isolation — shipped

**`tenant_id` on every top-level entity, enforced centrally.** The tenant
middleware ([`lib/tenant.js`](../lib/tenant.js)) resolves the caller's tenant
and scopes the repo (`req.repo`) to it on every request — the single
enforcement point recommended here, not per-handler `WHERE` clauses. Postgres
**Row-Level Security** backs it as defense-in-depth (#136, see
[`.claude/rules/tenancy-rls.md`](../.claude/rules/tenancy-rls.md)).
**Rejected, as planned:** database-per-tenant — operationally heavy at this
scale (migrations × N databases) for no real isolation gain over `tenant_id` +
RLS.

**Shipped (#139, 2026-07-19):** per-tenant quotas — a rounds-per-tenant cap, a
games-per-round cap (which transitively bounds cover-image storage), and a
tags-per-round cap — enforced in accounts mode only, all env-tunable. (A fourth
cap bounded the billed buy-next spend until that feature was removed in #264.)
Bounds abuse/cost before opening public sign-up (§12).

---

## 7. Code quality & maintainability

**Current — genuinely good for the size:**
- **Tests:** 19+ spec files ([`test/`](../test)) driving the app in-process via
  `supertest`, each in an isolated temp `DATA_DIR`
  ([`.claude/rules/automated-tests.md`](../.claude/rules/automated-tests.md)),
  including i18n key-parity enforcement and provider parsers tested against
  sample HTML with no network.
- **CI/CD:** `CI` (test matrix + coverage-threshold job) + `Lint` (eslint +
  syntax) on every push/PR; Dependabot weekly.
- **Coverage:** measured via Node's built-in `--experimental-test-coverage`;
  CI's `coverage:ci` job enforces line/function/branch floors.
- **Codified learnings:** a strong [`.claude/rules/`](../.claude/rules) culture
  captures the non-obvious traps — a real maintainability asset.

**Gap for production — mostly shipped but hand-rolled.** Observability
baseline (#132, [`lib/observability.js`](../lib/observability.js)) — `/healthz`,
structured JSON request logs, a central error handler — all shipped, but
deliberately **hand-rolled and dependency-free** ("no Sentry bundle" per the
file's own doc-comment). That trade-off made sense pre-launch; it doesn't
anymore now that real users hit this — see the shortlist below.

**Battle-tested-dependency candidates (production-readiness lens, not "keep it
minimal").** The mindset shift in [`CLAUDE.md`](../CLAUDE.md) applies most
directly here: several hand-rolled, security-or-correctness-critical pieces
now have a stronger case for a mature library than for growing the homegrown
version further. Filed as #211–#215 (2026-07-19).

1. **Postgres schema migrations + "no ORM" reopened — shipped (#211).**
   [`lib/repo/postgres.js`](../lib/repo/postgres.js) used to evolve the schema
   via `CREATE TABLE`/`ALTER TABLE ... IF NOT EXISTS` on every `init()`, tracked
   only by code comments, no migrations table, no rollback (a real incident: it
   needed a hand-written advisory lock to survive concurrent boots), and it
   hand-wrote every parameterized SQL string with the `JSON.stringify` +
   `::jsonb`-cast footgun (arrays silently becoming Postgres array literals).
   Now on **Knex** (query builder + built-in migrations, one dependency): the
   `~30` data-access methods use the fluent builder, schema lives in versioned
   migration files under [`lib/repo/migrations/`](../lib/repo/migrations)
   (`npm run migrate`), and `init()` runs `knex.migrate.latest()`. The baseline
   migration mirrors the old DDL idempotently, so it's a safe no-op on the live
   prod DB (records the baseline, no data change). It's **not** a full ORM — RLS,
   the tenant-scoped `tx`/`qt` `set_config`, advisory locks and `FOR UPDATE`
   stay on `knex.raw()` (a full ORM was rejected: it doesn't retrofit cleanly to
   RLS + the tenant-transaction pattern). The advisory lock **stays** — Knex's
   own migration lock doesn't cover the first-boot bookkeeping-table create race
   (verified). See [`.claude/rules/postgres-backend.md`](../.claude/rules/postgres-backend.md).
2. **Structured logging + error tracking** — the logging half is **shipped
   (#212)**: the hand-rolled JSON-line writer + request logger are now
   `pino`/`pino-http` internally, with the public `lib/observability.js` exports,
   the exact log shape/fields, and the no-PII request allowlist unchanged. The
   webhook-forward stand-in for a real error tracker (e.g. Sentry) is still
   open — **decided 2026-07-19 to scope the logging half only** and leave the
   error-tracking provider for a later decision (cost/DPA implications, §9).
3. **Request validation — shipped (#213).** Mutating routes used to hand-roll
   their own `typeof`/`Array.isArray` checks. A `zod` schema per body shape,
   run through the shared `lib/validate.js` helper, now makes body validation
   uniform at the router boundary (`rounds`/`games`/`sessions`/`account`).
4. **Identity/token issuance — access tokens shipped (#214).**
   [`lib/accounts.js`](../lib/accounts.js) was a well-built hand-rolled HMAC
   access-token + rotating-refresh-token scheme, but it gates real users'
   accounts. The access token is now a standard HS256 JWT issued/verified via
   the vetted `jsonwebtoken` library (`sub` = user id, `exp` = 15-min TTL,
   `SESSION_SECRET`-signed, `alg` pinned) — a code-only swap, **not** an IdP
   migration (that build-vs-buy question stays a separate, later decision, see
   §9). The refresh token deliberately stays opaque + hashed-at-rest — it isn't
   a JWT and doesn't need to be. Filed and shipped as **#214**.
5. **Rate-limit store** — `express-rate-limit`'s default in-memory store only
   works correctly for exactly one process. Fine today (single Railway
   instance); becomes wrong the moment horizontal scaling (§12 Phase 3) adds a
   second process. Track `rate-limit-redis` (or similar) as a prerequisite for
   scaling out, not an immediate fix. Filed as **#215**.

**Recommendation.** #1 (migrations/Knex) is **shipped (#211)** — it was the one
place a real production incident risk already existed. The rest are fast-follow
hardening, sequenced by how much production traffic has grown.

---

## 8. Hosting & operations — shipped

**Railway** builds the repo's `Dockerfile` and auto-deploys on push to `main`,
health-checked at `/healthz` (#131); paired with **managed PostgreSQL** (§3)
and **Cloudflare R2** for uploads. TLS terminates at Railway's edge (#156).
Full step-by-step, including the checklist of account/credential steps only a
human can do: [`docs/deploy-railway.md`](./deploy-railway.md).

**Rejected, as planned:** self-hosting Postgres, rolling your own TLS, or a
Kubernetes setup — all add operational burden managed services remove at this
scale. Cost envelope stayed hobby-scale (~€25–50/month); since #264 removed the
buy-next feature there is no pay-per-use AI spend on top of it.

---

## 9. Legal & compliance (DE/EU)

> **Research, not legal advice.** German/EU rules are fact-specific. The
> decision recorded in #134 (revised 2026-07-21) is that the launch texts are
> **self-reviewed against primary sources, not lawyer-reviewed** — a paid
> review buys little for a free, donations-only, no-tracking service. The
> "confirm with a lawyer" notes below are therefore **optional post-launch
> hardening**, not pre-launch gates; a professional review becomes effectively
> mandatory if a paid tier is ever introduced (#173).

Assume German UI, German/EU users, and (for the SaaS end-state) that you host
**strangers'** personal data — the line that turns most of this from optional
to mandatory.

### 9.1 Impressum — legal must (once non-private) — implemented (#134), activated at go-live

- The Impressum obligation moved from **§ 5 TMG to § 5 DDG** (Digitale-Dienste-
  Gesetz) effective **14 May 2024** (BGBl. 2024 I Nr. 149) — any Impressum/legal
  text must reference **DDG**, not TMG.
- A **purely private** site for friends/family generally needs no Impressum —
  today's shared-password-gated instance may fall under that exception. The
  moment the service is **public / offered to others** (multi-tenant
  sign-up), it is no longer "purely private" and an Impressum is **required**;
  omitting or mislabeling it is an *Ordnungswidrigkeit* with fines cited up to
  €50,000 in the worst case.
- **Optional post-launch hardening (lawyer):** whether the specific launch
  shape counts as private, and exactly what the Impressum must contain. The
  home-address exposure is solved by the **rented service address** (#134
  decision), consumed at runtime via `IMPRESSUM_ADDRESS`.

### 9.2 GDPR/DSGVO — legal must (once hosting real users' data) — open (#140)

- The app stores **personal data**: member names, ratings/opinions tied to
  people, and (with accounts) emails; server logs contain **IP addresses**.
  This triggers the full GDPR stack: a **privacy policy**, a **lawful basis**
  per processing purpose, **data-subject rights** (access/export/deletion —
  the app already deletes cleanly), **data minimization**, and **retention**
  limits.
- **Third-party processors** need **Data Processing Agreements**: the host,
  the managed DB, and object storage. Since **#264** removed the buy-next
  feature, the app makes **no outbound AI call** and there is no US
  LLM-processor transfer left to cover — the remaining processors are the
  hosting stack itself.
- **Optional post-launch hardening (lawyer/DPO):** lawful basis per purpose,
  retention periods, whether a DPIA is needed, and the international-transfer
  basis for the hosting processors — the launch texts (#134) record the
  self-reviewed answers (Art. 6(1)(b)/(f) per purpose; no DPIA — low risk, no
  special categories; SCC/DPF for Railway and Cloudflare).

### 9.3 Cookie / consent banner — probably not required today (verify)

- German cookie/consent law lives in **§ 25 TDDDG** (renamed TTDSG): consent
  is required for storing/reading device information **unless strictly
  necessary** for a requested service.
- **The app sets no cookies and uses `localStorage` only** for strictly
  necessary function (locale preference, auth session token) — likely falls
  under the necessity exception, so a consent banner is likely **not
  required**. Fonts are self-hosted, so no Google-Fonts consent issue either.
- **This changes** the moment analytics, ads, or other non-essential tracking
  is added. That the auth cookies qualify as "strictly necessary" is the
  self-reviewed position published in the #134 policy; a lawyer's confirmation
  is optional post-launch hardening.

### 9.4 Terms of use / DSA content rules — implemented (#140)

**Recorded conclusion (#173, 2026-07-21): no AGB obligation and no
Widerrufsbelehrung are due** — the service is free with unconditional
voluntary donations, so there is no consideration and no consumer contract.
That is a decision, not a gap. What *does* apply to any hosting service
regardless of size are the **DSA base duties** (Arts. 11/12/14/16–18 —
contact points, publicly stated content rules, notice-and-action, statements
of reasons, criminal-offence notification), and #140 shipped them as
**Nutzungsbedingungen** at
`/nutzungsbedingungen` (`lib/legal.js`, DE authoritative + EN, env-gated like
the other legal pages): explicit prohibited-content list, takedown/measures
clause, liability cascade, DSA contact points, plus the internal workflow +
Art. 17 statement-of-reasons templates (`docs/legal/notice-and-action.md`)
and a retention schedule (`docs/legal/retention.md` — moderation-log entries
with personal data: 3 years, § 195 BGB-aligned). Drafted Claude-only under
the same self-review bar as #134; there is deliberately **no minimum-age
clause** (no consent-based processing → Art. 8 DSGVO not triggered; hosting
service, not platform → no Art. 28 DSA duty) — the re-evaluation triggers
live in `.claude/rules/keep-legal-docs-current.md`. A lawyer pass remains
optional post-launch hardening, effectively mandatory before any paid tier
(#173).

---

## 10. Branding, name & domain — open, undecided

> Availability is a **snapshot** (checked via authoritative RDAP: Verisign for
> `.com`, DENIC for `.de`, registry bootstrap via `rdap.org` for `.app`) and is
> **not a trademark clearance**. A DPMA (German) + EUIPO (EU) register search
> in the relevant Nice classes, by an attorney, is required before committing.
> Rebranded to **"Spielwirbel"** on 2026-07-19 (issue #147): `app.title`/`<title>`
> and all brand-facing text now read "Spielwirbel", and `spielwirbel.de`/`.com`/
> `.app` are registered. The scope was deliberately the lightweight one (a
> Claude-assisted availability search, no attorney); a **formal DPMA + EUIPO
> clearance remains deferred** — still advisable before brand spend and
> effectively mandatory before a paid tier (see below and #173). The analysis
> that follows is kept as the rationale for why the old generic name was dropped.

**Current brand.** "Spieleabend" is **generic German for "game night."** As a
trademark it is descriptive → not distinctive → effectively unregistrable and
unenforceable, and the space is crowded (e.g. the AI game-night organizer
[Boardy](https://www.boardyboard.com/)). Fine as an *internal*/product name;
weak as a *brand*. `CLAUDE.md` already treats "Spieleabend" as the product
name and the entity as "Session," so a rebrand would touch `app.title`/
`<title>` and marketing copy, not the domain model.

**What makes a good pick:** a **coined / distinctive** word, short,
pronounceable in German *and* English, with `.com` **and** `.de` **and**
`.app` free.

**Shortlist (RDAP snapshot, all `avail` as of the original check):**

| Candidate | Angle | Notes |
|---|---|---|
| **`rundenwahl`** | DE "the round's choice" | **Top pick.** On-brand, distinctive, all TLDs free. Slightly descriptive in German → get an attorney read on distinctiveness. |
| **`ludopick`** | "ludo" (play) + "pick" | **Top pick.** Language-neutral, clearly coined, all TLDs free. |
| `ludoround` | "ludo" + "round" | Solid backup; a touch generic. |
| `spielwahl` | DE "game choice" | Descriptive in German (weaker mark). |
| ~~`meeplevote`~~ | meeple + vote | **Avoid** — "meeple" is a registered EU/DE trademark (Hans im Glück / Carcassonne), real conflict risk despite the domain being free. |

**Recommendation, still open.** Lead with **`rundenwahl`** or **`ludopick`**.
**Register the domain set early** (they go fast) but **get the attorney
trademark clearance (DPMA + EUIPO) before spending on brand assets.**
**Rejected: keep "Spieleabend" as the public brand** — unregistrable,
undifferentiated, SEO-invisible against the generic term; fine as a friendly
subtitle, not the brand to build on.

---

## 11. Internationalization & product readiness

**Current.** Solid i18n foundation: DE/EN with enforced key parity, locale
follows system language, overridable, persisted in `localStorage` — ahead of
most hobby projects and a real launch asset.

**Status of the product-readiness gaps this section originally flagged:**
- **Onboarding / empty states — shipped** (#138): sign-up → create-round →
  empty states. No invite step (see below).
- **Invitations** — a way to invite a *second account* into a tenant so it's a
  genuine co-member rather than a name-only seat. **Deferred to Phase 4
  (#207)**, not a launch requirement: a public first-run already works
  end-to-end with a single owner account adding name-only members.
- **Accessibility — still open.** No evidence of an a11y pass (focus
  management, ARIA, contrast — the color-mix-derived theme system, see
  [`.claude/rules/theme-derived-colors.md`](../.claude/rules/theme-derived-colors.md),
  helps but isn't a guarantee). Run an audit before public sign-up.
- **Mobile web — still open, verify.** The app is used on a couch; mobile is
  likely the primary device. Separate from the **native apps** covered in
  §2.4.
- **Legal surfaces in-product — shipped (#134):** the gated site footer links
  Kontakt, `/impressum` and `/datenschutz` on the SPA, the login page and the
  contact page; everything appears together once the go-live env is set (#219).

---

## 12. Phased roadmap

Effort: **S** ≈ hours–1 day · **M** ≈ days · **L** ≈ 1–2 weeks · **XL** ≈ weeks.
Risk = chance of getting it subtly wrong / blast radius.

### Phase 0 — Decide & prepare (no user impact)
| Item | Effort | Risk | Notes |
|---|---|---|---|
| Confirm end-state (multi-tenant SaaS) & this roadmap | S | Low | Decided (§1). |
| Attorney: trademark clearance for chosen name | S (external) | Med | **Blocker for brand spend**, not for code. |
| Register domain set (`.com`/`.app`/`.de`) | S | Low | Do early; cheap; reversible-ish. |

### Phase 1 — Milestone one: single authenticated instance 🔒 *(the going-live spine)*
**Status: shipped and live** — see [`docs/deploy-railway.md`](./deploy-railway.md).

| Item | Effort | Risk | Blocker? |
|---|---|---|---|
| **Move to PostgreSQL** + object storage for uploads; one-time file→DB migration | **L** | **High** | HARD BLOCKER (§3, §2.3) — **shipped** (#127, #128) |
| Make backend **stateless / single-writer-safe** (falls out of DB move) | M | High | HARD BLOCKER — **shipped** (#127) |
| **Auth gate** (single shared/small-user login, session cookies) | M | High | HARD BLOCKER (§5) — **shipped** (#129) |
| **TLS + `helmet` + rate limiting** | S–M | Med | HARD BLOCKER (§4) — **shipped** (#130, #156) |
| **Containerize + deploy pipeline + managed host** | M | Med | HARD BLOCKER (§8) — **shipped** (#131) |
| Central error handler, `/healthz`, structured logging, error tracking | M | Low | **shipped** (#132); see §7 for the follow-up (real error tracking, not the webhook stand-in) |
| Harden file uploads (content sniff/re-encode, safe extension) | S–M | Med | **shipped** (#133) |
| Impressum + privacy policy | S (+external) | Med | Required if not "purely private" (§9) — **implemented** (#134, self-reviewed per its revised completion bar); pages activate when the rented address is configured at go-live (#219/#226) |

*Exit (reached):* the group's data runs in the cloud, gated, on TLS, on a real
DB, with backups and monitoring. Public multi-tenant sign-up is still gated on
the rest of §12 (Impressum #134, legal pack #140; quotas #139 shipped) and a
deliberate decision to flip `ACCOUNTS_ENABLED` in production.

### Phase 1.5 — Harden the spine: prefer battle-tested deps over hand-rolled
Not go-live blockers (Phase 1 is already live) — closing the gap between
"shipped" and "production-battle-tested" now that the priority has shifted
(see the mindset note in [`CLAUDE.md`](../CLAUDE.md) and §7).

| Item | Effort | Risk | Issue |
|---|---|---|---|
| **Postgres schema migrations** + adopt **Knex** — **shipped** (#211) | L | Med | #211 |
| **Structured logging** — `pino`/`pino-http` — **shipped** (#212) | S–M | Low | #212 |
| **Centralized request validation** — `zod` at the router boundary — **shipped** (#213) | M | Low | #213 |
| **Identity/token issuance** — access-token JWTs via `jsonwebtoken` — **shipped** (#214) | M | Med | #214 |
| **Rate-limit shared store** (`rate-limit-redis` or similar) | S | Low | #215 |

See §7 for the reasoning behind each.

### Phase 2 — Multi-tenant SaaS
| Item | Effort | Risk | Blocker? |
|---|---|---|---|
| Account model (users, email verify, password reset) — built **token-first** so native apps share it (§2.4/§5) | **L** | **High** | Blocker for public sign-up (§5) — **shipped** (#135) |
| **Tenant model + isolation** (`tenant_id` everywhere, central enforcement, RLS) | **L** | **Very High** | Blocker — cross-tenant leak is catastrophic (§6) — **shipped** (#136) |
| Onboarding / first-run flow + empty states | M | Med | Blocker for usable sign-up (§11) — **shipped** (#138) |
| Per-tenant quotas (rounds, games, tags) | S–M | Med | Cost/abuse control — **shipped** (#139) |
| Terms of use (DSA content rules), DPAs (host, DB), transfer basis, retention | S (+external) | Med | Legal must for SaaS (§9) — **implemented** (#140; no AGB/Widerruf due per #173 — recorded in §9.4) |
| Consent mechanism **iff** non-essential tracking is added | S | Low | Conditional (§9.3) |

**Roles/permissions and invitations/tenant-sharing live in Phase 4, not here:**
"member" is already decoupled from "user" (a name-only seat the tenant owner
adds), so a single-owner tenant whose members are all name-only is a
**complete, launchable product** with no cross-tenant sharing and no role
model needed. Multi-user sharing of one tenant is real product value, but an
enhancement layered on a working single-owner launch — see #207.

### Phase 3 — Native apps, scale & polish (as needed)
| Item | Effort | Risk |
|---|---|---|
| Thin frontend build (content-hash cache-busting + minify) | S–M | Low | **shipped** (#141) |
| **PWA** — manifest + service worker, installable + offline (§2.4) | M | Low | **shipped** (#142) |
| **Capacitor wrapper** → App Store + Play Store apps; push + barcode scan (§2.4) | **L** | Med |
| **App-store compliance & mobile release pipeline** — dev accounts, signing, privacy labels, in-app account deletion, mobile CI (§2.4/§9) | M | Med |
| Horizontal scaling (multi-process behind LB — enabled by stateless tier) | M | Med |
| Accessibility audit + mobile-web responsiveness pass | M | Low |
| Localize server-side error messages if user-facing surfaces grow | S | Low |

### Phase 4 — Post-launch collaboration features (not go-live blockers)
A single-owner tenant with name-only members (today's model, unchanged) is a
complete public product on its own — nothing below is required to open public
sign-up. These are enhancements for groups that want more than one of their
members to hold their own login.

| Item | Effort | Risk |
|---|---|---|
| **Invitations & tenant-sharing** — let a second account join an existing tenant as a co-member (#207) | M–L | Med |
| **Roles & permissions** — owner/editor/viewer once a tenant has multiple accounts (#137) | M | Med |
| **Per-device voting** — a registered co-member votes from their own phone/browser in a running session, instead of one shared device (#209) | M | Low |

**Hard blockers, consolidated — all shipped:** real database + stateless tier
(§3/§2.3), authentication (§5), TLS + security headers + rate limiting (§4),
production hosting + deploy (§8), tenant isolation (§6), accounts (§5).
**What's left before public sign-up:** the legal pack (Impressum #134, blocked
externally; ToS/DPAs #140) — per-tenant quotas (#139) shipped — plus the Phase 1.5
hardening above is recommended, not blocking. Tenant *sharing*, roles, and
per-device voting are **not** in this list — see Phase 4.

---

## 13. Summary

The codebase was well-built for what it was, and none of it needed throwing
away — no rewrite happened or is planned (§1, §2). Going public was never an
architecture problem; it was an **operations, security, and data-model**
problem, concentrated in four hard blockers — a real database + stateless
tier, authentication, transport/edge security, and production hosting — **all
shipped**. What's left to open **public multi-tenant** sign-up is the legal
pack and quotas (§9, §6, §12), plus the **Phase 1.5 hardening** pass (§7) —
replacing what's currently hand-rolled-but-working (schema migrations,
logging/error tracking, request validation, token issuance) with
battle-tested dependencies now that production traffic makes that trade-off
worth it. The product also targets **native iOS/Android apps**: the PWA step
shipped, and reaching the stores is Capacitor wrapping the existing web UI
(§2.4), not a native rewrite. Legal work (Impressum under DDG, DSGVO privacy
policy) is a real must once strangers' data is hosted (§9), but the app's
no-tracking, self-hosted-fonts, `localStorage`-only design likely **needs no
cookie banner**. Branding (§10) remains the one open, undecided item with no
code dependency — pick a distinctive name and get trademark clearance before
spending on it.
