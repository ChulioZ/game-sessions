# 🎲 Spieleabend (Game Night)

[![CI](https://github.com/ChulioZ/game-sessions/actions/workflows/ci.yml/badge.svg)](https://github.com/ChulioZ/game-sessions/actions/workflows/ci.yml)
[![Lint](https://github.com/ChulioZ/game-sessions/actions/workflows/lint.yml/badge.svg)](https://github.com/ChulioZ/game-sessions/actions/workflows/lint.yml)
[![Secret Scan](https://github.com/ChulioZ/game-sessions/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/ChulioZ/game-sessions/actions/workflows/secret-scan.yml)

A self-hosted web app for any group or gaming round to manage their board
and digital games, decide what to play in a session, and track how much everyone
liked each game. The user interface is available in **German and English**; the
code and documentation are in English.

> ℹ️ **Status: local-only MVP.** Today this runs **local-only, with no
> authentication** — a deliberate starting point, not the destination. The goal
> is to bring it live as a hosted **website and app**; accounts, auth and a
> hosting story are the next phase. **For now, run it only on a trusted home
> network and don't expose it to the public internet** — there is no access
> control yet.

## Features

- **Rounds** – a group with a name and any number of members. The home screen
  is a lobby of round cards (members, game/session counts, last result); a new
  round is set up on a playful "seats around the table" screen, optionally
  importing the games list from an existing round.
- **Games** – each game has a title, a **platform** (Analog / PlayStation / Xbox
  / Switch / Steam / Sonstige), an expected duration (short / medium / long), a
  required player range (min–max), and an optional cover image (paste from
  clipboard or pick a file). The analog / digital type used by the filters and
  badges is derived from the platform (only "Sonstige" lets you pick it by hand).
  When adding a
  game, the title field doubles as a **search-as-you-type lookup**: it queries
  the **PlayStation Store**, **Steam**, the **Nintendo eShop** and the
  **Xbox / Microsoft Store** (digital games) and **BoardGameGeek** (board games)
  together and merges the hits into one
  dropdown. When several stores return the **same title** (e.g. a cross-platform
  game), they collapse into a **single row with one badge per platform** — click
  a badge to fill from that store, or the title to use the top match. Pick a
  suggestion to auto-fill the title, cover art, player range, play time and
  platform, and store a link back to the source page (shown on the game's detail
  view). The lookup is optional — manual entry works exactly as before, and the
  app degrades gracefully when a source is unreachable (one provider failing
  still shows the others' results).
  Details can be edited inline on the game's detail page. A game added by hand
  (with no source link) can be **linked to a provider after the fact** from its
  detail page: search the providers, pick the match, and choose which differing
  fields (cover, player count, play time, type) to take from it — the source
  link is always saved. Games are never lost by accident:
  instead of deleting, they are **retired** — kept with a timestamp in a
  browsable archive and restorable any time. Only already-retired games can be
  permanently deleted.
- **Members** – each member has a detail page (opened from the Start hero row,
  the Pokale podium, or a session's participant list) with their stats — wins,
  sessions joined, win rate, average rating given, and favorite game — and lets
  you rename them and pick their avatar color from the curated palette.
- **Round hub** – each round is a small app of its own, with a floating dock
  switching between four tabs:
  - **Start** – the launchpad: hero with the members, a big "start session"
    button, resumable in-progress sessions, the last played result, gentle
    retire recommendations for games that are rated low or often proposed for
    retirement, and **buy-next / play-next suggestions** (see below).
  - **Regal** (shelf) – the game collection as a card grid with filter chips
    (all / analog / digital), a search pill, sorting (random / name / rating),
    and the add-game sheet. Each card opens the game's detail page
    ("Spielepass") with its score ring, editable details, a **Jetzt spielen**
    launcher, and the history of sessions it appeared in.
  - **Chronik** – one month-grouped timeline of everything that happened:
    games added / retired / restored and session outcomes.
  - **Pokale** (trophies) – a winners' podium (ties share a step) plus stat
    tiles: most played, best rated, current winning streak, and the
    "Staubfänger" — the game gathering dust the longest.
- **Sessions (hot-seat voting)** – pick who is playing tonight, filter the
  collection by type and duration, and draw a random set of candidate games —
  only games whose player range fits the number of joining members are
  eligible. The device is then passed around: a handover screen names whose
  turn it is, and each member rates every drawn game **1–5** or proposes to
  retire it (member order is randomized).
- **Jetzt spielen** (play now) – when the group already knows what they want,
  launch a session for **one specific game** straight from its detail page or a
  Pokale tile: pick who joins and skip the vote entirely, landing directly on
  the results screen with that game chosen.
- **Finale & results** – votes stay sealed until everyone is done, then a
  little show reveals the results: per-game average (colored by score), rating
  distribution, medals for the favourites, and retirement proposals. Pick the
  game you actually played, mark it finished and record the winner(s) — or
  cancel the session if nothing appealed. Sessions can be deleted later, and a
  single game can be removed from a session's results.
- **Ratings on demand** – a game's average is always computed live from all
  session votes, so deleting a session automatically corrects every average.
- **Buy-next / play-next suggestions** – on the Start tab, a two-layer
  recommender. **Layer A** is always on and fully local: it resurfaces games you
  rate highly but rarely play, so loved titles get back on the table (no
  network, no key). **Layer B** is an opt-in "generate suggestions" button that
  asks an LLM for real new titles to consider buying, matched to your
  collection's taste; the result is cached per round. Suggestions are
  **platform-aware** (each pick is tagged with one of the platforms your round
  actually plays on, and carries a store-**search** link so you can go look it
  up), and their reason text is written in the **active UI language**. Every
  generation is **kept as a history** rather than overwriting the last, so you
  can page back through past runs (each shows its date/model), delete one you
  don't want, and no good earlier list is lost. It sends
  only an **anonymized taste profile** (game titles + collection shape, never
  member names or ids) to the [Claude API](https://www.anthropic.com/), and
  needs an `ANTHROPIC_API_KEY` — without one, the button reports it isn't set up
  and Layer A still works. This is the app's only outbound LLM call and it fires
  only when you press the button.
- **Designs** – per round, pick a colour scheme (page tone + accent); the
  whole UI derives from it — surfaces, shadows, even the dark "stage" of the
  finale.
- **Languages** – German and English, following the system language by
  default, switchable any time via the picker in the top bar.
- **Shareable links & reload-safe navigation** – the URL reflects the current
  screen (home, a round tab, a game, a member, a session result, …), so a
  reload keeps you where you were and any stable view can be bookmarked or
  linked to. Browser Back/Forward move between visited views.
- **Installable app (PWA)** – a web app manifest and a service worker make the
  app installable to a phone or desktop home screen and let the app shell load
  **offline** (the shell and static assets are cached; live round data still
  needs the network). In keeping with the no-build-step stance, the manifest,
  service worker and icons are plain static files.

## Tech & architecture

- **Backend:** Node.js + [Express](https://expressjs.com/). Routes read and write
  through a small **data-access layer** (`lib/repo/`) with two interchangeable
  backends: by default a single `data/data.json` file (loaded into memory, written
  atomically on every change — zero-dependency, right for local/home use), or
  **PostgreSQL** when `DATABASE_URL` is set (the stateless path for a hosted
  deployment; the app ensures its schema on startup). Cover images go through a
  matching storage seam (`lib/storage/`): files under `data/uploads/` by default,
  or **S3-compatible object storage** when `S3_BUCKET` is set (so uploads survive
  an ephemeral/scaled host). Only the `/uploads/<key>` path is persisted either
  way.
- **Frontend:** plain HTML/CSS/vanilla JS under `public/` — **no build step for
  development** (`npm start` serves `public/` directly). An *optional*
  cache-busting build (`npm run build`, issue #141) mirrors `public/` into
  `dist/` with content-hashed, minified JS/CSS for production; the server serves
  it only under `NODE_ENV=production`. It exists purely to bust stale asset
  caches after a deploy — not a bundler or framework.
- **Hardening:** [helmet](https://helmetjs.github.io/) sets security headers
  (CSP, `X-Content-Type-Options`, frame options, HSTS) and
  [express-rate-limit](https://express-rate-limit.mintlify.app/) caps requests —
  a generous global limit plus a stricter one on the billable buy-next endpoint.
  TLS is expected to terminate at a reverse proxy (`TRUST_PROXY` then forwards
  the real client IP); see the env vars below. Responses are gzip-compressed
  ([compression](https://github.com/expressjs/compression)), and content-hashed
  build assets are served immutable (`sw.js` stays no-cache so updates roll out).
- **Observability:** a `/healthz` liveness/readiness probe, structured JSON
  request/error logs to stdout (`LOG_LEVEL`, no bodies or personal data), and a
  central error handler so unexpected throws never leak a stack trace — they
  return a generic 500 and are logged (and optionally forwarded to
  `ERROR_WEBHOOK_URL`). See `lib/observability.js`.
- **Runs entirely on your machine.** Fonts and the icon set are self-hosted
  under `public/fonts/`, and the subtle background grain is an inline SVG in the
  stylesheet — no CDNs. The only runtime external calls are **opt-in**: the
  add-game lookup queries the PlayStation Store, Steam, the Nintendo eShop, the
  Xbox / Microsoft Store and BoardGameGeek server-side (via `/api/lookup/*`) only
  when you type a title to search; it sends just the search text and the active
  UI language, and the app works fully without it. None of these need an API key
  or account. BoardGameGeek titles follow the **active UI language** (German or
  English, falling back to the other), so a German search fills in the German
  game name. The PS Store locale defaults to `de-de` (`PSSTORE_LOCALE`); Steam
  defaults to the German store, `de`/`german` (`STEAM_CC` / `STEAM_LOCALE`); the
  Nintendo eShop defaults to the German store, `de` (`NINTENDO_LOCALE`); the
  Xbox / Microsoft Store defaults to the German store, `de-de` (`XBOX_LOCALE`).
  The one exception is the **buy-next suggestions** feature: pressing its
  "generate" button calls the [Claude API](https://www.anthropic.com/)
  server-side (via `/api/rounds/:rid/recommendations`) and requires an
  `ANTHROPIC_API_KEY`. It is strictly opt-in (only on that click), sends an
  anonymized taste profile with no member identifiers, and the app is fully
  functional without the key.

```
server.js            starts the HTTP server (the only place that listens)
lib/
  app.js             builds the Express app: static files + route modules,
                     plus the SPA fallback (serves index.html for frontend
                     routes so deep links / reloads work)
  repo/              data-access layer: the async API every route reads/writes
                     through (getRound + typed mutators). One seam, two backends:
    index.js         picks the backend (DATABASE_URL ? postgres : json)
    json.js          default backend — the data/data.json store below
    postgres.js      PostgreSQL backend (schema + SQL), used when DATABASE_URL set
  store.js           the JSON backend's engine: in-memory data + atomic
                     load/save to the data/ folder, id/activity helpers
  storage/           cover-image storage: one seam, two backends
    index.js         picks the backend (S3_BUCKET ? s3 : disk)
    disk.js          default backend — files under DATA_DIR/uploads
    s3.js            S3-compatible object storage, used when S3_BUCKET set
  upload.js          multer image-upload config (persists via lib/storage)
  observability.js   structured logging, /healthz, central error handler
  providers/         external game-database providers for the add-game lookup
    index.js         provider registry + image-host allowlist
    psstore.js       PlayStation Store: search + detail via the store's
                     server-rendered page data (digital games)
    bgg.js           BoardGameGeek: search via Wikidata (maps a name to a BGG
                     id), detail via BGG's public JSON endpoint (board games)
    steam.js         Steam: search + detail via the store's public JSON
                     endpoints (storesearch / appdetails) (digital games)
    nintendo.js      Nintendo eShop: search + detail via Nintendo of Europe's
                     public Solr endpoint (Switch games)
    xbox.js          Xbox / Microsoft Store: search via the storefront
                     autosuggest API, detail via the public catalog service
                     (digital games)
routes/
  lookup.js          /api/lookup            (search/game — provider proxy: PS Store, BGG, Steam, Nintendo, Xbox)
  rounds.js          /api/rounds            (list, detail, create, delete)
  games.js           …/games                (add [+cover download/source],
                                             edit [+link to provider],
                                             retire/restore, delete)
  members.js         …/members              (edit name / avatar color)
  sessions.js        …/sessions             (start, results, choice, finish,
                                             cancel, delete, remove one game)
  activities.js      …/activities           (list the feed [GET], delete an entry)
  background.js      …/background           (set the design)
  recommendations.js …/recommendations      (buy-next run history: list [GET],
                                             generate & append via Claude [POST],
                                             delete one run [DELETE /:runId])
public/
  index.html
  login.html         standalone login page (shown only when AUTH_PASSWORD is set)
  styles.css
  manifest.webmanifest  PWA manifest (installable app metadata + icons)
  sw.js              service worker: precache the app shell, offline fallback
  fonts/             self-hosted fonts + Tabler icon set
  icons/             PWA / home-screen app icons (192, 512, apple-touch)
  js/
    i18n.js          translation engine (t(), locale detection)
    lang/en.js       English strings
    lang/de.js       German strings
    core.js          DOM/API helpers, stats, design, language picker  (loads first)
    ranking.js       tie-aware podium places ("1, 2, 2, 4")
    buynext.js       local "play these again" recommender (Layer A)
    views-home.js    lobby + new round
    views-round.js        round hub (Start/Regal/Chronik/Pokale dock) + Start tab
    views-round-tabs.js   Regal, Chronik, Pokale tabs + retired games
    views-round-detail.js game detail, design picker, sheet helpers
    views-round-lookup.js provider lookup, add game, link provider
    views-member.js  member detail page (stats, name/color editing)
    views-session.js session setup, voting (hot-seat), finale, results
    router.js        URL ↔ view routing (History API): deep links, reloads
    main.js          bootstrap: route from the current URL              (loads last)
    pwa.js           registers the service worker (installable + offline)
scripts/
  build.js           optional cache-busting build: mirrors public/ into dist/
                     with content-hashed, minified js/css (npm run build)
  migrate-json-to-postgres.js  one-off data.json → PostgreSQL import
test/                automated tests (node --test + supertest)
data/                all user data (git-ignored)
  data.json          created on first run
  uploads/           cover images
dist/                optional build output (git-ignored; npm run build)
Dockerfile           production container image (node:22-slim, non-root, /data volume)
.dockerignore        keeps secrets + user data out of the build context
docker-compose.yml   one-command run with a persistent /data volume
.github/workflows/   CI: tests, lint, secret scan, Docker image build + publish
```

The frontend files are plain `<script>`s that share one global scope; **load
order matters** (see `index.html`).

## Requirements

- **Node.js 18 or newer.** If you don't have it, download the latest LTS
  installer from <https://nodejs.org/> and run it — that's the only prerequisite.
  (Developed and tested on Node 26.)

## Running

```bash
npm install
npm start          # or: node server.js
```

Open <http://localhost:3000>.

From other devices on your home network: `http://<your-computer-ip>:3000`
(find the IP with e.g. `ipconfig getifaddr en0` on macOS).

Use a different port: `PORT=8080 npm start`
Use a different data folder: `DATA_DIR=/path/to/data npm start`
Enable buy-next AI suggestions: `ANTHROPIC_API_KEY=sk-ant-… npm start`
(optional — everything else works without it)

Use PostgreSQL instead of the JSON file: `DATABASE_URL=postgres://… npm start` (the
app creates its schema on first start; add `DATABASE_SSL=true` for managed Postgres
that requires TLS). Unset, it uses `DATA_DIR/data.json` as before.

Migrate an existing `data/data.json` into a fresh Postgres database (one-off, with
the server **stopped**): `DATABASE_URL=postgres://… npm run migrate:postgres`. It
copies every round into Postgres preserving ids, and refuses to run against a
non-empty target. See `scripts/migrate-json-to-postgres.js`.

Store cover images in S3-compatible object storage instead of on local disk (for
a stateless, scalable app tier): `S3_BUCKET=my-bucket npm start`. Set `S3_ENDPOINT`
(+ usually `S3_FORCE_PATH_STYLE=true`) for non-AWS stores like Cloudflare R2,
Backblaze B2 or MinIO; credentials come from `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`
or the AWS default provider chain. Unset, images stay under `DATA_DIR/uploads` as
before. See the S3 block in `.env.example`.

Behind a TLS-terminating proxy: `TRUST_PROXY=1 npm start` (so rate limiting sees
the real client IP). Tune the limits with `RATE_LIMIT_MAX` (global, per 15 min)
and `RECS_RATE_LIMIT_MAX` (buy-next generations, per hour).

Require a login: set `AUTH_PASSWORD=…` (and optionally `SESSION_SECRET=…`) to gate
the whole app behind a single shared password — an unauthenticated visitor gets a
login page and the API returns `401`. Leave `AUTH_PASSWORD` unset (the default) and
the app stays open, as the local-only MVP runs today. Tune the login brute-force
limit with `AUTH_RATE_LIMIT_MAX` (attempts per 15 min, default 20). The session is
a signed, httpOnly cookie (marked `Secure` automatically behind a TLS proxy).

Observability: logs go to stdout as structured JSON; set `LOG_LEVEL`
(`silent`/`error`/`warn`/`info`, default `info`) to tune verbosity, and
`ERROR_WEBHOOK_URL` to have unexpected 500s POSTed to an alerting webhook. The
`/healthz` endpoint returns `{ status: 'ok', uptime, timestamp }` for uptime
monitors.

### Configuration via a `.env` file

All settings above are plain environment variables (see `.env.example` for the
full list). To keep them in a file instead of the command line, copy the
template and start with `start:env`:

```bash
cp .env.example .env      # then edit .env and fill in what you need
npm run start:env         # loads .env, then runs the server
```

`start:env` uses Node's built-in `--env-file-if-exists` (Node ≥ 20.12; a missing
`.env` is fine), so there is no extra dependency. **`.env` is gitignored** — it
may hold your `ANTHROPIC_API_KEY`, so never commit it. Plain `npm start` ignores
`.env` and reads only real environment variables.

### With Docker

A production container image is provided (`Dockerfile`, `node:22-slim`, runs as a
non-root user). Build and run it directly:

```bash
docker build -t spieleabend .
docker run -p 3000:3000 -v spieleabend-data:/data spieleabend
```

Or use Compose — `docker compose up` builds the image and wires the same
persistent volume. Data (rounds, sessions, uploaded covers) lives on the mounted
**`/data`** volume, so it survives restarts and redeploys; point `DATABASE_URL` /
`S3_BUCKET` elsewhere for a stateless app tier. Configure everything via
`-e`/`environment:` (see `.env.example`). The image sets `NODE_ENV=production`, so
it serves the content-hashed build (`dist/`).

**TLS is not in the image** — terminate it at a reverse proxy or managed platform
in front of the container, then set `TRUST_PROXY=1` (see issue #156). On merge to
`main`, CI publishes the image to the GitHub Container Registry
(`ghcr.io/chulioz/game-sessions`), so a host can pull it instead of building.

### Deploying to Railway (production)

The production target is [Railway](https://railway.com): it builds the
`Dockerfile` (config in `railway.json`, health-checked at `/healthz`) and
auto-deploys on push to `main`. Pair it with **managed PostgreSQL** (Railway
plugin → `DATABASE_URL`, the #127 backend) and **Cloudflare R2** for cover images
(S3-compatible → the #128 backend via `S3_ENDPOINT`); Railway terminates TLS at
its edge, so set `TRUST_PROXY=1`. The full step-by-step — EU region, custom
domain, and the account/secret steps only you can do — is in
[`docs/deploy-railway.md`](docs/deploy-railway.md).

## Development

```bash
npm test              # automated tests (Node's built-in runner + supertest)
npm run coverage      # tests with a coverage report (built-in, no extra deps)
npm run lint          # ESLint (flat config)
npm run check:syntax  # node --check over all JS files
npm run build         # optional: content-hash + minify js/css into dist/
```

`coverage` uses Node's built-in `--experimental-test-coverage`, so it needs no
extra dependency. CI also runs `coverage:ci`, which adds line/function/branch
thresholds and fails the build if coverage drops below them (Node ≥ 22.8).

`build` (issue #141) is **optional** and only for production: it writes a
`dist/` mirror of `public/` with content-hashed, minified JS/CSS (via
[`esbuild`](https://esbuild.github.io/)) so a changed asset gets a fresh URL and
never serves stale after a deploy. The server uses `dist/` only under
`NODE_ENV=production`; plain `npm start` always serves the live-editable
`public/` tree, so day-to-day development stays build-free. Delete `dist/` (or
just don't build) to go back to serving `public/`.

CI runs the test suite plus a coverage check, lint, and syntax checks on every
push and pull request, and a gitleaks secret scan fails the build if a credential
is ever committed; Dependabot keeps dependencies updated via weekly PRs.

## Contributing

This project is built and maintained with [Claude Code](https://claude.com/claude-code),
and the repository ships the workflow with it: a set of **skills** in
`.claude/skills/` and **rules** in `.claude/rules/` that encode how work gets
done here. Whether you contribute by prompting Claude Code or by hand, these are
the intended path — start there rather than improvising.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the ground rules and the
**contribution-licensing terms** — inbound contributions are licensed under
Apache-2.0 (so the project can stay commercially relicensable) and every commit
must be signed off under the Developer Certificate of Origin (`git commit -s`).

### Before you start

- Read `CLAUDE.md` — it states the current constraints (local-only MVP, no auth
  yet, no build step, no framework, no database; German UI, English code), the
  architecture you must work within, and the roadmap intent (going live as a
  hosted website and app).
- Skim `.claude/rules/` — one short file per hard-won gotcha (frontend script
  load order, the shared-global-scope lint setup, theme-derived colours, why you
  must never read the production `data/` folder, …). When you touch an area a
  rule covers, follow it. Found a new gotcha? Add a rule file for it.

### The skill workflow

The skills chain into a backlog-to-merge pipeline. Invoke a skill in Claude Code
by name (e.g. `/implement`), or just describe the task and let the matching skill
trigger. Each is self-contained and enforces this repo's constraints.

| Skill | What it does |
| --- | --- |
| **`create-issue`** | Interviews you and files a GitHub issue specific enough to implement without follow-up questions, grounded in this repo's architecture. |
| **`pick-issue`** | Surveys open issues (and pending Dependabot PRs), ranks them by value-for-effort, and hands the best next one to the right builder skill. |
| **`implement`** | Takes a change end-to-end: branch from up-to-date `main`, write the code **plus tests**, review locally, open a PR, review it, and merge only if it's safe — then watch `main`'s CI and clean up. |
| **`review-pr`** | Reviews a pull request (human or bot) against this repo's constraints and returns a `SAFE TO MERGE` / `NOT SAFE` verdict with concrete blockers. |
| **`dependabot`** | Triages open Dependabot PRs, merging what passes review and commenting on what doesn't. |
| **`test-data`** | Creates isolated, throwaway data in a temp `DATA_DIR` for tests or manual runs — the safe alternative to ever touching the real `data/`. |

A typical flow: **`create-issue`** to capture the work → **`pick-issue`** to
choose what's next → **`implement`** to ship it (it calls `review-pr` before
merging). For dependency bumps, **`dependabot`** handles the batch.

### Doing it by hand

If you'd rather not drive Claude Code, the same expectations apply:

- Branch off an up-to-date `main` (never commit on `main`); use a descriptive
  name like `feat/session-export` or `fix/vote-tie`.
- Add or update tests for testable changes, and add any new user-facing string
  to **both** `public/js/lang/en.js` and `de.js` (key parity is enforced by a
  test).
- Make `npm test`, `npm run lint`, and `npm run check:syntax` all pass before
  opening a PR.
- Update `README.md` in the same PR when the change adds/renames a user-facing
  feature, alters the file tree above, or changes routes, scripts, or env vars.

## Data & backup

Everything lives in the `data/` folder (`data.json` + `uploads/`) — copy it to
back up, delete it to reset. The whole folder is git-ignored so your group's
data is never committed.

## About this project

This project was **developed entirely by Claude** (Anthropic's AI models,
via Claude Code), through an interactive, conversational process: a human described the
desired features and gave feedback, and Claude designed and wrote all of the
code, comments, and documentation. It stands as a small example of what
agentic, AI-assisted development can produce end to end.

Note the distinction from the "runs entirely on your machine" point above: the
app's *development* was AI-driven, but the app itself contains no AI and sends
no data anywhere when you run it.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE), © 2026 Julian Zenker — the sole
rights holder and licensor. The source is public and you are free to use, study,
modify, and share it for **noncommercial** purposes (personal use, hobby
projects, education, research). Commercial use — including running it as a paid
or revenue-generating hosted service — is not granted by this license; contact
the maintainer for commercial terms.
