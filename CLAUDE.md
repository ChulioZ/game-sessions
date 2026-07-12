# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this is

A small self-hosted web app for any group or gaming round to
manage their games, run "what should we play?" voting sessions, and track ratings. UI language is
**German**; code, comments here, and docs are **English**.

**Current stage — local-only MVP.** Today the app runs **local-only**, with
intentionally **no authentication**, for a trusted home network. That is the
*current MVP scope*, not the end goal: the intent is to bring this live as a
hosted **website and app** (which will eventually need accounts, auth, and a
hosting/storage story). So treat local-only / no-auth as *where we are now*, not
a permanent principle — but don't build auth, accounts, or cloud services
**ad-hoc or unprompted**. Those are staged roadmap work to do deliberately when
asked, not to bolt onto an unrelated change as a side effect.

## Architecture (read before changing things)

- **No build step, no framework, no database.** Keep it that way unless asked.
- **Backend:** Express. `server.js` only wires middleware and mounts routers.
  - `lib/store.js` is the single source of truth: an in-memory `data` object
    persisted to `data/data.json` via atomic `saveData()` (temp file + rename).
    Mutate `data` in place; never reassign it. Use `findRound`, `id`,
    `pushActivity` from here. The data location is overridable via `DATA_DIR`.
  - `lib/upload.js` is the multer config for cover images (stored under
    `data/uploads/`, only the path is saved in `data.json`).
  - `routes/*.js` are Express routers, one per resource, mounted under
    `/api/rounds/...`. Nested routers use `{ mergeParams: true }` for `:rid`.
- **Frontend:** `public/js/*.js` are plain classic `<script>`s sharing one global
  scope. They are loaded in a fixed order (see `public/index.html`):
  `i18n.js` → `lang/en.js` → `lang/de.js` → `core.js` → `views-home.js` →
  `views-round.js` → `views-session.js` → `main.js`. i18n + languages load first
  (so `t()` is available everywhere), `core.js` holds shared helpers/state, and
  `main.js` calls `initLocale()`/`showHome()` last.
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
  "Spieleabend" (`app.title`, `<title>`) names the product, not the entity,
  and is the one intentional exception.
- There is intentionally **no one-time migration code** in the backend; the live
  `data.json` is fully up to date. For a future schema change, migrate the data
  once (with the server stopped, see `.claude/rules/`) rather than keeping
  migration code around permanently.
- Data is small (one group). Prefer simple, readable code over optimization.
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
