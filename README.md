# 🎲 Spieleabend (Game Night)

[![CI](https://github.com/ChulioZ/game-sessions/actions/workflows/ci.yml/badge.svg)](https://github.com/ChulioZ/game-sessions/actions/workflows/ci.yml)
[![Lint](https://github.com/ChulioZ/game-sessions/actions/workflows/lint.yml/badge.svg)](https://github.com/ChulioZ/game-sessions/actions/workflows/lint.yml)

A small, self-hosted web app for any group or gaming round to manage their board
and digital games, decide what to play in a session, and track how much everyone
liked each game. The user interface is available in **German and English**; the
code and documentation are in English.

> ⚠️ **Local use only — no authentication.** This app has intentionally **no
> login or access control**. Run it only on a trusted home network. Do not
> expose it to the public internet.

## Features

- **Rounds** – a group with a name and any number of members. The home screen
  is a lobby of round cards (members, game/session counts, last result); a new
  round is set up on a playful "seats around the table" screen, optionally
  importing the games list from an existing round.
- **Games** – each game has a title, type (analog / digital), an expected
  duration (short / medium / long), a required player range (min–max), and an
  optional cover image (paste from clipboard or pick a file). Details can be
  edited inline on the game's detail page. Games are never lost by accident:
  instead of deleting, they are **retired** — kept with a timestamp in a
  browsable archive and restorable any time. Only already-retired games can be
  permanently deleted.
- **Round hub** – each round is a small app of its own, with a floating dock
  switching between four tabs:
  - **Start** – the launchpad: hero with the members, a big "start session"
    button, resumable in-progress sessions, the last played result, and gentle
    retire recommendations for games that are rated low or often proposed for
    retirement.
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
- **Designs** – per round, pick a colour scheme (page tone + accent); the
  whole UI derives from it — surfaces, shadows, even the dark "stage" of the
  finale.
- **Languages** – German and English, following the system language by
  default, switchable any time via the picker in the top bar.

## Tech & architecture

- **Backend:** Node.js + [Express](https://expressjs.com/). No database — a
  single `data/data.json` file is the source of truth (loaded into memory,
  written atomically on every change). Cover images are stored as files under
  `data/uploads/`; only their paths live in `data.json`.
- **Frontend:** plain HTML/CSS/vanilla JS under `public/` — **no build step**.
- **Runs entirely on your machine.** No data is sent to any external service.
  Fonts and the icon set are self-hosted under `public/fonts/`, and the subtle
  background grain is an inline SVG in the stylesheet — no CDNs or third-party
  APIs are involved at runtime.

```
server.js            starts the HTTP server (the only place that listens)
lib/
  app.js             builds the Express app: static files + route modules
  store.js           in-memory data + atomic load/save (data/ folder), helpers
  upload.js          multer image-upload config
routes/
  rounds.js          /api/rounds            (list, detail, create, delete)
  games.js           …/games                (add, edit, retire/restore, delete)
  sessions.js        …/sessions             (start, results, choice, finish,
                                             cancel, delete, remove one game)
  activities.js      …/activities           (delete an entry)
  background.js      …/background           (set the design)
public/
  index.html
  styles.css
  fonts/             self-hosted fonts + Tabler icon set
  js/
    i18n.js          translation engine (t(), locale detection)
    lang/en.js       English strings
    lang/de.js       German strings
    core.js          DOM/API helpers, stats, design, language picker  (loads first)
    ranking.js       tie-aware podium places ("1, 2, 2, 4")
    views-home.js    lobby + new round
    views-round.js   round hub (Start/Regal/Chronik/Pokale), archive,
                     design picker, game detail, add game
    views-session.js session setup, voting (hot-seat), finale, results
    main.js          bootstrap: showHome()                            (loads last)
test/                automated tests (node --test + supertest)
data/                all user data (git-ignored)
  data.json          created on first run
  uploads/           cover images
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

## Development

```bash
npm test              # automated tests (Node's built-in runner + supertest)
npm run lint          # ESLint (flat config)
npm run check:syntax  # node --check over all JS files
```

CI runs the test suite plus lint and syntax checks on every push and pull
request; Dependabot keeps dependencies updated via weekly PRs.

## Contributing

This project is built and maintained with [Claude Code](https://claude.com/claude-code),
and the repository ships the workflow with it: a set of **skills** in
`.claude/skills/` and **rules** in `.claude/rules/` that encode how work gets
done here. Whether you contribute by prompting Claude Code or by hand, these are
the intended path — start there rather than improvising.

### Before you start

- Read `CLAUDE.md` — it states the non-negotiables (local-only, no auth, no build
  step, no framework, no database; German UI, English code) and the architecture
  you must work within.
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

[MIT](LICENSE)
