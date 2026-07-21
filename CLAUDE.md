# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this is

A self-hosted web app for any group or gaming round to
manage their games, run "what should we play?" voting sessions, and track ratings. UI language is
**German**; code, comments here, and docs are **English**.

**Current stage — live production, heading toward public multi-tenant SaaS.**
The app started as a local-only, no-auth MVP for a trusted home network; that
stage is over. It now runs in production on Railway (managed PostgreSQL, R2
object storage, TLS — see `docs/deploy-railway.md`), and the token-first
account model, tenant isolation, and onboarding UI (issues #135/#136/#138) are
shipped, staged behind `ACCOUNTS_ENABLED` for opening public registration (see
`.claude/rules/accounts-mode-gate.md`). Full status and remaining launch work:
`docs/production-readiness.md`.

**What this changes about how to work here.** Priority has shifted from
*staying minimal* to *production-ready*: correctness under concurrent/
multi-tenant load, security, observability, and long-term maintainability now
outweigh keeping the dependency count low for its own sake. Where a mature,
widely-used dependency solves a problem this codebase currently hand-rolls
(schema migrations, structured logging/error tracking, request validation —
see `docs/production-readiness.md` §7 for the current shortlist), prefer
adopting it over growing the homegrown version further. This does **not**
relax discipline elsewhere: still build roadmap work deliberately when asked,
not as a side effect of an unrelated change.

The architecture calls below were re-examined under this lens on 2026-07-19
and still hold on their own merits (with one revision: "no ORM" became "Knex,
not a full ORM", #211) — they are not leftover localhost-era minimalism.

## Architecture (read before changing things)

- **No build step for development, no framework (frontend).** Keep it that way
  unless asked — re-examined for the public multi-tenant end-state
  (`docs/production-readiness.md` §2.2) and it held up: the app is already a
  working client-side-routed SPA, a framework rewrite buys nothing it can't
  already do, and the one real risk (shared-global-scope load-order
  fragility) is a maintainability tax already contained by `.claude/rules/`,
  not a production-safety issue. The one sanctioned exception is the
  *optional* cache-busting build (`scripts/build.js` / `npm run build`, issue
  #141): it content-hashes + minifies `public/js/**` + `styles.css` into
  `dist/`, served only under `NODE_ENV=production` — see
  `.claude/rules/frontend-build-cache-busting.md`. Don't grow it into a
  bundler/framework, and don't add a build step elsewhere ad-hoc.
- **Persistence has two backends** (below): the default JSON file, or
  PostgreSQL when `DATABASE_URL` is set. Don't add a *third* store ad hoc —
  that call is still good, it's about not fragmenting round-data storage
  across more than one source of truth (a Redis dependency for something
  that isn't round data, e.g. rate-limiting, doesn't violate it). **The
  "no ORM" question was reopened and settled with Knex (#211):**
  `lib/repo/postgres.js` now uses the **Knex query builder** (no more
  hand-written SQL strings, which sidesteps the JSONB/array serialization
  footgun) and **versioned Knex migration files** in `lib/repo/migrations/`
  (`npm run migrate`) instead of an inline DDL template. It is deliberately
  **not** a full ORM — RLS, the tenant-scoped `tx`/`qt` `set_config` pattern,
  advisory locks and `FOR UPDATE` still drop to `knex.raw()` (that raw escape
  hatch is exactly why Knex was chosen over Prisma). Don't reintroduce raw
  `pool.query` for round data, and don't reach for a full ORM. See
  `.claude/rules/postgres-backend.md` and `docs/production-readiness.md` §7.
- **Backend:** Express. `server.js` only wires middleware, mounts routers, and
  `await repo.init()`s the backend before listening.
  - `lib/repo/` is the **data-access layer**: the async API every route reads and
    writes through (`getRound`/`listRounds` return snapshots; typed mutators like
    `createGame`, `finishSession`, `deleteRound` persist one change). Routes must
    go through it — never touch `lib/store.js` directly. `index.js` picks the
    backend at require time: **`postgres.js`** when `DATABASE_URL` is set, else the
    default **`json.js`**. Both satisfy the same contract, so routes don't change
    when the backend does. See `.claude/rules/data-access-layer.md`.
  - `lib/store.js` is the **JSON backend's** engine (used by `repo/json.js`): the
    single in-memory `data` object persisted to `data/data.json` via atomic
    `saveData()` (temp file + rename). Mutate `data` in place; never reassign it.
    `id`/`findRound`/`pushActivity` live here for that backend (and the store's own
    tests); new route code calls the repo, not these. Location via `DATA_DIR`. The
    Postgres backend (`repo/postgres.js`) is standalone — it does not use `store`.
  - `lib/upload.js` is the multer config for cover images (persisted via the
    `lib/storage/` seam — disk under `data/uploads/` by default, S3 when
    `S3_BUCKET` is set; only the `/uploads/<key>` path is saved in the data).
  - `routes/*.js` are Express routers, one per resource, mounted under
    `/api/rounds/...`. Nested routers use `{ mergeParams: true }` for `:rid`.
- **Frontend:** `public/js/*.js` are plain classic `<script>`s sharing one global
  scope, loaded in a fixed order. The **authoritative list is the `<script>`
  tags in `public/index.html`** — consult it rather than any summary. The
  invariants: `i18n.js` + the `lang/*.js` tables load first (so `t()` is
  available everywhere), small dependency-free helper modules and `core.js`
  (shared helpers/state) load before the `views-*.js` files, and
  `router.js` → `main.js` → `pwa.js` come last (`main.js` bootstraps).
  (`login.js`, `kontakt.js` and `admin.js` are separate IIFEs loaded only by
  their own standalone HTML pages, outside this shared scope.)
  - **Load-order trap:** a top-level statement in an earlier file must not
    reference a function/`const` defined in a later file at *load time* (it isn't
    defined yet). Defer such references (e.g. wrap in an arrow that runs on
    click/navigation). See `.claude/rules/`.
  - Rating averages are computed **on demand** from session votes (see
    `gameStats` in `core.js`) — sessions are the single source of truth, so
    deleting a session automatically removes its effect. Don't denormalize.

## Internationalization

- The UI is German + English. **Never hard-code user-facing text in views.**
  Add a key to **both** `public/js/lang/en.js` and `public/js/lang/de.js`, then
  use `t('key', { params })` (see `js/i18n.js`). Keep the two files in key parity.
- The active locale follows the system language and is overridable via the top-bar
  picker (stored in `localStorage`). Changing it re-renders the current screen via
  the `currentView` callback that each `show*` view sets at its start.
- Server error messages are English only (rarely surfaced; client-side validation
  is localized).

## Conventions

- Match the surrounding style: 2-space indent, single quotes, `'use strict';` in
  Node files, **English comments and code**.
- The "retire" domain concept (a game kept but taken out of the active list) uses
  English identifiers throughout: data fields `retired`/`retiredAt`, the vote flag
  `retire`, activity type `game_retired`, route `…/games/:gid/retire`, the
  `showRetired` view. The German display word "Aussortieren" lives only in
  `lang/de.js`.
- The core entity (a voting/play session) is called **"Session"** — in code
  (`sessions`, `…/sessions` routes) *and* in both UI languages. Don't
  reintroduce "Spielabend", "game night", or "Abend" for it. The app brand
  "Spielwirbel" (`app.title`, `<title>`) names the product, not the entity,
  and is the one intentional exception (it replaced the earlier working name
  "Spieleabend" in the #147 rebrand — don't reintroduce that either).
- There is intentionally **no one-time migration code** in the backend; the live
  `data.json` is fully up to date. For a future schema change, migrate the data
  once (with the server stopped, see `.claude/rules/`) rather than keeping
  migration code around permanently.
- The default JSON backend (`lib/repo/json.js`) still assumes one small dataset
  and favors simple, readable code over optimization — that's fine for
  local/self-hosted use. **Production runs the Postgres backend instead**
  (`lib/repo/postgres.js`, tenant-scoped, RLS-enforced), which now holds many
  tenants' data — don't assume "small, one group" when touching anything
  tenant-scoped or Postgres-specific.
- Keep the `data/` folder out of git (already in `.gitignore`).
- **Never read the production `data/` directory** (`data/data.json`,
  `data/uploads/`) — it is private user data. Reference the schema from code
  and tests, and generate your own data in an isolated `DATA_DIR` when you need
  something to run against. See `.claude/rules/no-reading-production-data.md` and
  the `test-data` skill.

## Running & verifying

- Start: `npm start` (serves on `http://localhost:3000`; `PORT` env to change).
- Tests: `npm test` (Node's built-in `node --test`; specs in `test/*.test.js`).
  Add/update tests with new features and keep them green — see `.claude/rules/`.
- Lint: `npm run lint` (ESLint flat config in `eslint.config.js`). Keep it green;
  the frontend shared-global-scope pattern needs care — see `.claude/rules/`.
- Quick syntax check: `node --check <file>`, or `npm run check:syntax` for all.
- CI runs `npm test` (CI workflow) plus lint + syntax (Lint workflow) on every
  push/PR; Dependabot (`.github/dependabot.yml`) opens weekly dependency-update
  PRs, which those workflows then validate.
- API smoke tests: `curl` against `http://localhost:3000/api/...`.
- For UI changes, verify in a real browser. Note: a non-painted/headless preview
  tab may not flush `requestAnimationFrame`, so grid contents that render via
  rAF can appear empty until a paint (e.g. a screenshot) occurs — this is a
  preview artifact, not a bug.

## Capturing learnings → `.claude/rules/`

Whenever a **non-obvious learning** is made during a session — a gotcha, a
constraint, a "why it's done this way," something that wasn't apparent from the
code and cost effort to discover — **write it down as a short rule file in
`.claude/rules/`** so future sessions don't rediscover it the hard way.

- One learning per file: `.claude/rules/<kebab-case-topic>.md`.
- Keep it short: what the rule is, and *why* (the symptom/trap it prevents).
- Add new rules as you find them; update or remove a rule if it becomes wrong.
- These rules are committed to the repo (unlike `.claude/settings.local.json`).
