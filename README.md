# 🎲 Familien-Spielesammlung (Family Game Collection)

[![CI](https://github.com/ChulioZ/game-sessions/actions/workflows/ci.yml/badge.svg)](https://github.com/ChulioZ/game-sessions/actions/workflows/ci.yml)
[![Lint](https://github.com/ChulioZ/game-sessions/actions/workflows/lint.yml/badge.svg)](https://github.com/ChulioZ/game-sessions/actions/workflows/lint.yml)

A small, self-hosted web app for a family (or any group) to manage their board
and digital games, decide what to play in a session, and track how much everyone
liked each game. The user interface is available in **German and English**; the
code and documentation are in English.

> ⚠️ **Local use only — no authentication.** This app has intentionally **no
> login or access control**. Run it only on a trusted home network. Do not
> expose it to the public internet.

## Features

- **Rounds** – create a group with a name and any number of members.
- **Games** – add games with a title, type (🎲 analog / 💻 digital) and an
  optional cover image (paste from clipboard or pick a file). Games are never
  deleted, only **retired** ("aussortiert") — kept with a timestamp and viewable
  on a separate page, and restorable.
- **Sessions (Hot-Seat)** – draw a random number of games (filter by
  all / analog / digital). The device is passed around: a handover screen names
  whose turn it is, then each member rates every drawn game **1–5** or proposes
  to retire it. Member order is randomized.
- **Results** – per-game average (colored by score), rating distribution,
  medals for the favourites, and how often retirement was proposed. Pick
  which game you actually played, mark it finished, and record the winner(s).
- **Per-game stats & detail page** – each game shows its average rating (computed
  on demand from all sessions) and a history of the sessions it appeared in.
- **Activity feed** – per round: games added / retired / restored, and session
  outcomes ("… won X").
- **Retire recommendations** – games that are often proposed for retirement or
  rated very low get a gentle, dismissible suggestion.
- **Sorting & import** – sort the games list (random / name / rating); create a
  new round by importing the games list from an existing one.
- **Designs** – per round, pick a colour scheme; the whole UI adapts to it —
  accent, surfaces, and a calm backdrop with a soft accent glow and paper grain.
- **Languages** – German and English, following the system language by default,
  switchable any time via the picker in the top bar.

## Tech & architecture

- **Backend:** Node.js + [Express](https://expressjs.com/). No database — a
  single `data/data.json` file is the source of truth (loaded into memory,
  written atomically on every change). Cover images are stored as files under
  `data/uploads/`; only their paths live in `data.json`.
- **Frontend:** plain HTML/CSS/vanilla JS under `public/` — **no build step**.
- **Runs entirely on your machine.** No data is sent to any external service.
  Even the subtle background grain is an inline SVG in the stylesheet — no
  third-party APIs are involved.

```
server.js            Express app: static files + mounts the route modules
lib/
  store.js           in-memory data + atomic load/save (data/ folder), helpers
  upload.js          multer image-upload config
routes/
  rounds.js          /api/rounds            (list, detail, create, delete)
  games.js           …/games                (add, retire/restore)
  sessions.js        …/sessions             (start, results, choice, finish, delete)
  activities.js      …/activities           (delete an entry)
  background.js      …/background            (set the design)
public/
  index.html
  styles.css
  js/
    i18n.js          translation engine (t(), locale detection)
    lang/en.js       English strings
    lang/de.js       German strings
    core.js          DOM/API helpers, stats, design, language picker  (loads first)
    views-home.js    home + new round + activity feed
    views-round.js   round overview, retired games, design, game detail, add game
    views-session.js start session, voting (hot-seat), results
    main.js          bootstrap: showHome()                            (loads last)
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

## Data & backup

Everything lives in the `data/` folder (`data.json` + `uploads/`) — copy it to
back up, delete it to reset. The whole folder is git-ignored so your family's
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
