# 🌀 Spielwirbel

[![CI](https://github.com/ChulioZ/spielwirbel/actions/workflows/ci.yml/badge.svg)](https://github.com/ChulioZ/spielwirbel/actions/workflows/ci.yml)
[![Lint](https://github.com/ChulioZ/spielwirbel/actions/workflows/lint.yml/badge.svg)](https://github.com/ChulioZ/spielwirbel/actions/workflows/lint.yml)
[![Secret Scan](https://github.com/ChulioZ/spielwirbel/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/ChulioZ/spielwirbel/actions/workflows/secret-scan.yml)

A self-hosted web app for any group or gaming round to manage their board
and digital games, decide what to play in a session, and track how much everyone
liked each game. The user interface is available in **German and English**; the
code and documentation are in English.

> ℹ️ **Status: live in production, heading toward public multi-tenant SaaS.**
> The maintainer's instance runs hosted (managed PostgreSQL, object storage,
> TLS, an auth gate, and a token-first account model — see "Environment
> variables" below); public sign-up isn't open yet. **Self-hosting still
> defaults to local-only with no authentication** unless you set the env vars
> below — if you run it that way, keep it on a trusted network you control,
> since there's no access control until you configure one.

## Features

- **Rounds** – a group with a name and any number of members. The home screen
  is a lobby of round cards (members, game/session counts, last result); a new
  round is set up on a playful "seats around the table" screen, optionally
  importing the games list from an existing round.
- **Games** – each game has a title, a required player range (min–max), any
  number of custom round **tags** (see below), and an optional cover image (paste
  from clipboard or pick a file). When adding a
  game, the title field doubles as a **search-as-you-type lookup**: it queries
  the **PlayStation Store**, **Steam**, the **Nintendo eShop** and the
  **Xbox / Microsoft Store** (digital games) and **BoardGameGeek** (board games)
  together and merges the hits into one
  dropdown. When several stores return the **same title** (e.g. a cross-platform
  game), they collapse into a **single row with one badge per store** — click
  a badge to fill from that store, or the title to use the top match. Pick a
  suggestion to auto-fill the title, cover art and player range, and store a link
  back to the source page (shown on the game's detail
  view). The lookup is optional — manual entry works exactly as before, and the
  app degrades gracefully when a source is unreachable (one provider failing
  still shows the others' results).
- **Providers per round** – each round chooses which of the five databases its
  lookups query (a "Provider" screen next to Tags in the round hub). A
  board-games-only group can switch the four digital stores off so their hits
  stop crowding the dropdown — and the requests stop being made at all. A round
  that never configures it queries all five, as before; turning *every* provider
  off is allowed too and simply leaves the title field a plain text input.
  **Provider cover art is hotlinked, not copied:** the picture is loaded straight
  from the store's own servers rather than downloaded onto this instance, because
  re-hosting third-party box art on a public service needs a licence we don't
  have (issue #172). Your own uploaded covers are stored normally. One
  consequence to expect: if a store moves or removes an image, that cover stops
  showing — re-link the game or upload your own picture.
  Details can be edited inline on the game's detail page. A game added by hand
  (with no source link) can be **linked to a provider after the fact** from its
  detail page: search the providers, pick the match, and choose which differing
  fields (name, cover, player count) to take from it — the source
  link is always saved. A link can also be **removed again** from the same
  detail page if the match turns out to be wrong; a hotlinked provider cover is
  cleared with it (your own uploaded cover is kept). Games are never lost by accident:
  instead of deleting, they are **archived** — kept with a timestamp in a
  browsable archive and restorable any time. There are two archives, because
  the reason matters: **retired** ("Aussortiert") means the group wants rid of
  the game, **completed** ("Durchgespielt") means they finished its content — a
  campaign, a legacy box, a story-driven video game. A game is active, retired
  or completed, never two at once, and either archive can be reached from the
  round hub's footer. Only an already-archived game can be permanently
  deleted. Two rounds can be **consolidated**: "Spiele verschieben" in the
  shelf's footer moves *all* of a round's games — archived ones included, with
  their covers, provider links and tags — into another of your rounds, merging
  same-named tags. The emptied round stays behind; its session history does
  not, since a session cannot reference games that now live elsewhere.
- **Tags** – every round can define its own free-form tags (e.g. "outside",
  "quick lunch break", "digital", "co-op") on a dedicated screen reached from the
  Start tab. Tags are the single way to categorize games. Assign
  any number of tags to a game — in the add-game sheet or later from the game's
  detail page, creating new tags inline — and filter both the Regal and the
  session draw by them (tri-state chips: off / include / exclude; included tags
  combine with AND, excluded tags reject any match). Each tag can carry an
  **icon** picked from a curated set, shown next to its name everywhere the tag
  appears; a tag without one keeps the default tag glyph, and the icon can be
  changed later from the Tags screen.
  Deleting a tag simply unassigns it from every game.
- **Members** – each member has a detail page (opened from the Start hero row,
  the Pokale podium, or a session's participant list) with their stats — wins,
  sessions joined, win rate, average rating given, and favorite game — and lets
  you rename them and pick their avatar color from the curated palette.
- **Round hub** – each round is a small app of its own, with a floating dock
  switching between four tabs:
  - **Start** – the launchpad: hero with the members, a big "start session"
    button, resumable in-progress sessions, the last played result, and gentle
    retire recommendations for games that are rated low or often proposed for
    retirement.
  - **Regal** (shelf) – the game collection as a card grid with custom-tag
    filter chips, a search pill, sorting
    (random / name / rating),
    and the add-game sheet. Each card opens the game's detail page
    ("Spielepass") with its score ring, editable details, a **Jetzt spielen**
    launcher, and the history of sessions it appeared in.
  - **Chronik** – one month-grouped timeline of everything that happened:
    games added / retired / restored and session outcomes.
  - **Pokale** (trophies) – a winners' podium (ties share a step) plus stat
    tiles: most played, best rated, current winning streak, and the
    "Staubfänger" — the game gathering dust the longest.
- **Sessions (hot-seat voting)** – pick who is playing tonight, optionally filter
  the collection by custom tags, and draw a random set of candidate games —
  only games whose player range fits the number of joining members are
  eligible. The tags and count a round was last drawn with are remembered and
  preselected the next time, so a group that always draws the same way just
  confirms. The device is then passed around: a handover screen names whose
  turn it is, and each member rates every drawn game **1–5** or proposes to
  retire it (member order is randomized).
- **Jetzt spielen** (play now) – when the group already knows what they want,
  launch a session for **one specific game** straight from its detail page or a
  Pokale tile: pick who joins and skip the vote entirely, landing directly on
  the results screen with that game chosen.
- **Finale & results** – votes stay sealed until everyone is done, then a
  little show reveals the results: per-game average (colored by score), rating
  distribution, medals for the favourites, and retirement proposals. Pick the
  game you actually played and mark it finished; recording the winner(s) is an
  optional follow-up step afterwards — or
  cancel the session if nothing appealed. Sessions can be deleted later, and a
  single game can be removed from a session's results.
- **Ratings on demand** – a game's average is always computed live from all
  session votes, so deleting a session automatically corrects every average.
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
- **Feedback** – a button in the top bar opens a short form for telling the
  operator what is missing, confusing or broken, together with the screen it was
  written on. Submissions are **anonymous by default**: when accounts are on,
  attaching your e-mail address so the operator can reply is a separate, opt-in
  checkbox that is never ticked for you. The operator reads what comes in from
  the moderation panel (see below) — there is no third-party feedback service
  and no analytics script involved.

## Tech & architecture

- **Backend:** Node.js + [Express](https://expressjs.com/). Routes read and write
  through a small **data-access layer** (`lib/repo/`) with two interchangeable
  backends: by default a single `data/data.json` file (loaded into memory, written
  atomically on every change — zero-dependency, right for local/home use), or
  **PostgreSQL** when `DATABASE_URL` is set (the stateless path for a hosted
  deployment; the app ensures its schema on startup). All round data is
  **tenant-scoped** (issue #136): every request resolves to a tenant (the single
  `default` tenant unless user accounts are enabled) and the data layer only
  ever sees that tenant's rounds — on Postgres additionally enforced by
  row-level security in the database itself. Cover images go through a
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
  [express-rate-limit](https://express-rate-limit.mintlify.app/) caps requests
  with a generous global limit.
  Mutating request bodies are validated at the router boundary with
  [zod](https://zod.dev/) schemas (via `lib/validate.js`).
  TLS is expected to terminate at a reverse proxy (`TRUST_PROXY` then forwards
  the real client IP); see the env vars below. Responses are gzip-compressed
  ([compression](https://github.com/expressjs/compression)), and content-hashed
  build assets are served immutable (`sw.js` stays no-cache so updates roll out).
- **Observability:** a `/healthz` liveness/readiness probe, structured JSON
  request/error logs to stdout (`LOG_LEVEL`, no bodies or personal data), and a
  central error handler so unexpected throws never leak a stack trace — they
  return a generic 500 and are logged (and optionally forwarded to
  `ERROR_WEBHOOK_URL`). The same logger also emits a handful of product-usage
  events (round/session/game/tag created, session finished) carrying only the
  event name and tenant id — no analytics service, no cookies, no client-side
  tracking. See `lib/observability.js`.
- **Runs entirely on your machine.** Fonts and the icon set are self-hosted
  under `public/fonts/`, and the subtle background grain is an inline SVG in the
  stylesheet — no CDNs. The only runtime external calls are **opt-in**: the
  add-game lookup queries the PlayStation Store, Steam, the Nintendo eShop, the
  Xbox / Microsoft Store and BoardGameGeek server-side (via
  `/api/rounds/:rid/lookup/*`, and only the providers that round enabled) only
  when you type a title to search; it sends just the search text and the active
  UI language, and the app works fully without it. None of these need an API key
  or account. BoardGameGeek titles follow the **active UI language** (German or
  English, falling back to the other), so a German search fills in the German
  game name. The PS Store locale defaults to `de-de` (`PSSTORE_LOCALE`); Steam
  defaults to the German store, `de`/`german` (`STEAM_CC` / `STEAM_LOCALE`); the
  Nintendo eShop defaults to the German store, `de` (`NINTENDO_LOCALE`); the
  Xbox / Microsoft Store defaults to the German store, `de-de` (`XBOX_LOCALE`).

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
    postgres.js      PostgreSQL backend (Knex query builder), used when DATABASE_URL set
    migrations/      versioned Knex schema migrations (npm run migrate)
  tenant.js          resolves each request's tenant and scopes the repo to it
  store.js           the JSON backend's engine: in-memory data + atomic
                     load/save to the data/ folder, id/activity helpers
  storage/           cover-image storage: one seam, two backends
    index.js         picks the backend (S3_BUCKET ? s3 : disk)
    disk.js          default backend — files under DATA_DIR/uploads
    s3.js            S3-compatible object storage, used when S3_BUCKET set
  upload.js          multer image-upload config (persists via lib/storage)
  auth.js            shared-password gate (active when AUTH_PASSWORD is set)
  admin.js           operator gate for the moderation surface (separate
                     ADMIN_PASSWORD; 404s unless set — issue #268)
  accounts.js        user-account primitives: Argon2id passwords, access/refresh
                     tokens (issue #135; off unless ACCOUNTS_ENABLED)
  mail.js            outbound e-mail (Brevo when BREVO_API_KEY is set, else
                     logged to an in-memory outbox)
  csv.js             RFC 4180 CSV writer for the operator panel's exports
                     (issue #288) — quotes every field, so a feedback message
                     with commas/quotes/newlines cannot corrupt the file, and
                     neutralizes leading =/+/-/@ so it cannot become an Excel
                     formula
  observability.js   structured logging, /healthz, central error handler
  status.js          derived instance configuration for the operator panel's
                     status card (issue #274) — booleans/enums only, never a
                     secret value
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
  auth.js            /api/auth              (shared-password login/logout/status)
  account.js         /api/account           (user accounts: register, verify
                                             e-mail, login, refresh, logout,
                                             forgot/reset password, me —
                                             404 unless ACCOUNTS_ENABLED)
  contact.js         /api/contact           (public contact form → e-mails the
                                             operator; no auth, own rate limit,
                                             honeypot; fails loud in production)
  legal.js           /impressum, /datenschutz,
                     /nutzungsbedingungen    (server-rendered legal pages,
                                             identity from IMPRESSUM_* env;
                                             404 until configured)
  admin.js           /api/admin             (operator moderation: instance
                                             status, lookup by image/round/
                                             e-mail/tenant, per-tenant summary,
                                             round text + redaction, takedown,
                                             account suspend/restore, GDPR
                                             export + erasure, filterable action
                                             log, user feedback —
                                             404 unless ADMIN_PASSWORD)
  feedback.js        /api/feedback          (in-app user feedback: submit one
                                             message; read side lives on
                                             /api/admin — issue #260)
  lookup.js          …/lookup               (search/game — provider proxy: PS Store, BGG, Steam, Nintendo, Xbox;
                                             round-scoped, refuses a provider the round disabled)
  rounds.js          /api/rounds            (list, detail, create, delete)
  games.js           …/games                (add [+cover hotlink/source],
                                             edit [+link to provider],
                                             retire/restore, complete/restore,
                                             delete, move all to another round)
  members.js         …/members              (edit name / avatar color)
  sessions.js        …/sessions             (start, results, choice, finish,
                                             cancel, delete, remove one game)
  activities.js      …/activities           (list the feed [GET], delete an entry)
  background.js      …/background           (set the design)
  tags.js            …/tags                 (create a custom tag [deduped], set its icon, delete one)
  providers.js       …/providers            (set which lookup providers this round queries)
public/
  index.html
  login.html         standalone login page (shown only when AUTH_PASSWORD is set)
  kontakt.html       standalone public contact form (bilingual, no login needed)
  admin.html         standalone operator moderation page (needs ADMIN_PASSWORD)
  styles.css
  manifest.webmanifest  PWA manifest (installable app metadata + icons)
  sw.js              service worker: precache the app shell, offline fallback
  fonts/             self-hosted fonts + Tabler icon set
  icons/             PWA / home-screen app icons (192, 512, apple-touch)
  js/
    login.js         login.html's own script — an IIFE, not part of the
                     shared global scope below (only loaded by login.html)
    kontakt.js       kontakt.html's own script — an IIFE (bilingual form),
                     not part of the shared global scope (only loaded there)
    admin.js         admin.html's own script — likewise an IIFE outside the
                     shared scope, so no privileged code ships in the SPA
    i18n.js          translation engine (t(), locale detection)
    lang/en.js       English strings
    lang/de.js       German strings
    core.js          DOM/API helpers, stats, design, language picker  (loads first)
    account.js       onboarding + auth UI (login/register/verify/reset), token wiring
    ranking.js       tie-aware podium places ("1, 2, 2, 4")
    cover.js         deterministic per-title gradient for games with no cover
    cover-size.js    rewrites provider cover URLs to a frame-appropriate size
    tag-icons.js     the curated tag-icon set (mirrors lib/tag-icons.js)
    swr.js           stale-while-revalidate cache: views render instantly from
                     the last known data while a background fetch refreshes
    lookup-group.js  collapses same-title provider hits into one multi-badge row
    lookup-cover.js  which cover image a picked provider match yields
    focus-trap.js    keeps Tab inside an open sheet + restores focus on close
    feedback.js      top-bar feedback button + submission sheet (issue #260)
    views-home.js    lobby + new round
    views-round.js        round hub (Start/Regal/Chronik/Pokale dock) + Start tab
    views-round-tabs.js   Regal, Chronik, Pokale tabs + the two archive
                          screens (retired / completed)
    views-round-detail.js game detail, design picker, tags + providers screens,
                          sheet helpers
    views-round-lookup.js provider lookup, add game, link provider
    views-member.js  member detail page (stats, name/color editing)
    views-session.js session setup, voting (hot-seat), finale, results
    router.js        URL ↔ view routing (History API): deep links, reloads
    main.js          bootstrap: route from the current URL              (loads last)
    pwa.js           registers the service worker (installable + offline)
scripts/
  build.js           optional cache-busting build: mirrors public/ into dist/
                     with content-hashed, minified js/css (npm run build)
test/                automated tests (node --test + supertest)
data/                all user data (git-ignored)
  data.json          created on first run
  uploads/           cover images
dist/                optional build output (git-ignored; npm run build)
Dockerfile           production container image (node:22-slim, non-root,
                     writes to DATA_DIR=/data; no VOLUME instruction — Railway's
                     builder rejects it, see .claude/rules/)
.dockerignore        keeps secrets + user data out of the build context
docker-compose.yml   one-command run with a persistent /data volume
knexfile.js          Knex config (Postgres) shared by the app + the migrate CLI
railway.json         Railway build/deploy config (see docs/deploy-railway.md)
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

Use PostgreSQL instead of the JSON file: `DATABASE_URL=postgres://… npm start` (the
app runs its Knex migrations on start, so the schema is created/updated
automatically; add `DATABASE_SSL=true` for managed Postgres that requires TLS).
Unset, it uses `DATA_DIR/data.json` as before. Migrations can also be run
explicitly with `npm run migrate` (and authored with `npm run migrate:make -- <name>`).

Store cover images in S3-compatible object storage instead of on local disk (for
a stateless, scalable app tier): `S3_BUCKET=my-bucket npm start`. Set `S3_ENDPOINT`
(+ usually `S3_FORCE_PATH_STYLE=true`) for non-AWS stores like Cloudflare R2,
Backblaze B2 or MinIO; credentials come from `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`
or the AWS default provider chain. Unset, images stay under `DATA_DIR/uploads` as
before. See the S3 block in `.env.example`.

Behind a TLS-terminating proxy: `TRUST_PROXY=1 npm start` (so rate limiting sees
the real client IP). Tune the limits with `RATE_LIMIT_MAX` (global, per 15 min)
and `CONTACT_RATE_LIMIT_MAX` (contact-form submissions, per 15 min, default 5).

Contact form (issue #224): a public, login-free page at `/kontakt.html` with a
bilingual form that POSTs to `/api/contact`, which e-mails the operator — the
phone-free second communication channel a German Impressum (§ 5 DDG) relies on, and
the DSA notice-and-action channel. Delivery goes to `CONTACT_TO` (falling back to
`MAIL_FROM`) via the same Brevo setup as the account mails. It has its own low rate
limit and a server-side honeypot for spam, and in `NODE_ENV=production` it **fails
loud** (`502` with a fallback e-mail) rather than silently dropping a message when
mail is unconfigured — so configure `BREVO_API_KEY` + `MAIL_FROM` + `CONTACT_TO`
before relying on it in production. A shared site footer links to it — but the
footer (and the form itself) only appears once the public `GET /api/config`
reports the instance ready: mail configured **and** the Impressum identity set
(all-or-nothing, so a half-configured deploy shows no public footer rather than
a broken one).

Legal pages (issues #134/#140): `GET /impressum`, `GET /datenschutz` and
`GET /nutzungsbedingungen` serve the server-rendered DDG Impressum, the DSGVO
privacy policy and the terms of use / DSA content rules (German authoritative,
English courtesy translation on the same page). The operator identity comes from
env at request time — `IMPRESSUM_ADDRESS` (postal address, may be multi-line)
and `IMPRESSUM_EMAIL` — so no address ever lives in the repo; while either is
unset all three routes answer 404 and the site footer stays hidden. The
registration form links the terms; the internal notice-and-action workflow and
retention schedule live in `docs/legal/`.

Serving one deployment under several domains: `CANONICAL_HOST` + `REDIRECT_HOSTS`
(issue #230) 301 the branded non-canonical domains onto a single canonical origin
(default: `spielwirbel.de`/`.com` + `www` → `spielwirbel.app`). It's an
allowlist, so it never touches the canonical host, a platform domain like
`*.up.railway.app`, or a load-balancer health-check host. Point them at your own
domains, or set `REDIRECT_HOSTS` empty to disable. See the block in `.env.example`.

Per-tenant quotas (issue #139): in the public multi-tenant mode (`ACCOUNTS_ENABLED=true`)
each tenant is capped on rounds (`MAX_ROUNDS_PER_TENANT`, default 10), games per
round (`MAX_GAMES_PER_ROUND`, default 1000), and custom tags per round
(`MAX_TAGS_PER_ROUND`, default 30). With accounts off (the
default, single-tenant deploy) these are inert. See the quotas block in `.env.example`.

Require a login: set `AUTH_PASSWORD=…` (and optionally `SESSION_SECRET=…`) to gate
the whole app behind a single shared password — an unauthenticated visitor gets a
login page and the API returns `401`. Leave `AUTH_PASSWORD` unset and the app
stays open with no access control (the default for a bare local checkout — the
maintainer's hosted instance sets it). Tune the login brute-force
limit with `AUTH_RATE_LIMIT_MAX` (attempts per 15 min, default 20). The session is
a signed, httpOnly cookie (marked `Secure` automatically behind a TLS proxy).

User accounts (issue #135): the token-first account model — register with
e-mail + password (Argon2id-hashed), e-mail verification, login issuing short-lived
access tokens + rotating refresh tokens, and password reset — lives under
`/api/account`. It is **off by default**: set `ACCOUNTS_ENABLED=true` *and* a
strong `SESSION_SECRET` to expose it. Verification/reset mails go out via Brevo
(`BREVO_API_KEY`, `MAIL_FROM`, links built from `APP_BASE_URL`); without a key
they are logged instead of sent.

When accounts are enabled the app runs in **accounts mode** (issue #138): the SPA
shows an in-app onboarding flow — register → confirm e-mail → log in, plus password
reset and a first-run empty state — and the `/api` data routes require a valid
account token (there is no anonymous access, and each account sees only its own
tenant's rounds, #136). With accounts **off** (the default, and today's
production) the shared-password gate above is unchanged. Enabling accounts in
production is a deliberate step (it replaces the shared gate and starts sending
mail); *inviting other people into a shared tenant is still follow-up work (#207),
as are roles (#137)*.

Operator moderation (issues #268/#273/#274/#275): setting `ADMIN_PASSWORD`
exposes `/admin.html` + `/api/admin`, the standalone operator panel for acting
on abuse notices and data-subject requests. It can resolve a notice by reported
cover path, round link, e-mail address or tenant id (with a per-tenant summary
shown against the quota ceilings); take a cover image down (deletes the object
*and* clears every reference); **redact** any user-authored text — round name,
game title, member name, tag name, feedback message — by overwriting the field
with `[entfernt]` while preserving the original wording on the log entry a DSA
Art. 17 statement of reasons has to quote (redaction never deletes a row);
suspend or restore an account without deleting anything, effective immediately
(existing access tokens stop working); **export** everything held for one
account as JSON (GDPR Art. 15/20); and perform an Art. 17 **erasure** — the
account, its tenant's rounds and the stored cover objects — which demands a
reason plus the account's own e-mail typed as confirmation and refuses if a
second account still shares the tenant. Every action lands in a log filterable
by tenant, action and date range; the erasure entry records only ids, date,
reason and counts, never the erased content, since the log outlives the erasure
it evidences.

The panel opens with an **Instanz-Status** card: how the running instance is
*actually* configured — accounts mode, whether the secrets are distinct, mail
delivery, image/data backends, pending migrations, quota ceilings, canonical
host, whether built `dist/` assets are served, and the running version. Every
field is a derived boolean, enum or number — **no secret value is ever
returned**. A **Feedback** card shows what users sent through the in-app
feedback button (with the sender's address only where they opted in); tune
submissions per IP with `FEEDBACK_RATE_LIMIT_MAX` (per 15 min, default 10).
The Feedback and Protokoll cards page rather than truncate (`100 von 342`,
**Mehr laden**) and export *every* entry as UTF-8 CSV (BOM included, so Excel
renders umlauts correctly).

`ADMIN_PASSWORD` must be a **separate** secret from `AUTH_PASSWORD`: the latter
is shared with everyone using the instance, while these powers cross tenant
boundaries. Optionally set `ADMIN_SESSION_SECRET` to sign the admin cookie
(otherwise `SESSION_SECRET`, then the password itself). Leave `ADMIN_PASSWORD`
unset — the default — and the entire surface `404`s.

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
may hold your `SESSION_SECRET` and provider credentials, so never commit it.
Plain `npm start` ignores
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
(`ghcr.io/chulioz/spielwirbel`), so a host can pull it instead of building.

> ⚠️ **Self-hosters: the image moved.** With the Spielwirbel rebrand (#230) the
> repository was renamed `game-sessions` → `spielwirbel`, so the published image
> is now **`ghcr.io/chulioz/spielwirbel`**. GHCR packages do **not** auto-redirect
> like repo URLs, so the old `ghcr.io/chulioz/game-sessions` tags are frozen and
> receive no new builds. Update your `docker-compose.yml`/`docker run` to pull the
> new path.

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
npm run migrate       # apply pending Postgres migrations (needs DATABASE_URL)
npm run migrate:make -- <name>  # scaffold a new Postgres migration file
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

- Read `CLAUDE.md` — it states the current stage (live in production, heading
  toward public multi-tenant SaaS — see `docs/production-readiness.md`), the
  architecture you must work within (no frontend build step, no framework, no
  ORM; German UI, English code), and the production-readiness mindset that now
  applies to new work.
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
