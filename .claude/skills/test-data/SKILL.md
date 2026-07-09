---
name: test-data
description: >-
  Create isolated, throwaway test data for automated tests (or manual dev runs)
  and clean it up afterward. Use when a test or a local experiment needs rounds,
  games, sessions, or votes to run against, and you must NOT touch the real
  data/ folder. Covers the temp-DATA_DIR pattern, seeding via the API vs. a raw
  data.json, and teardown.
---

# Create & tear down test data

The production `data/` folder is **strictly off-limits** to read or write — it is
private household data (see `.claude/rules/no-reading-production-data.md`). So
never copy, edit, or point tests at the real file. Instead, spin up an **isolated
dataset in a temp folder** via `DATA_DIR`, fill it with data you generate, and
throw the whole folder away afterward.

## The one rule that makes this work: set `DATA_DIR` first

`lib/store.js` reads `data.json` into memory **once at require-time** and keeps it
there. So the isolation only holds if `process.env.DATA_DIR` points at your temp
folder **before** the first `require('../lib/store')` (which happens transitively
through `require('../lib/app')`). Set it too late and you get the real `data/` or
an already-cached copy. See `.claude/rules/automated-tests.md`.

`node --test` runs **each test file in its own process**, so every file gets a
fresh, empty dataset and there is no cross-file bleed.

## For automated tests: use `test/helpers.js`

`test/helpers.js` already does the temp-folder dance in the right order and
exports a ready `app`, the `store`, the temp `DATA_DIR`, and a `createRound`
helper. Require it **first** in a test file — do not require `lib/app` or
`lib/store` above it.

```js
const { app, store, createRound } = require('./helpers');
const request = require('supertest'); // drives the app in-process, opens no port
```

### Prefer seeding through the API

Build data the same way the app does, so it stays valid (IDs, validation,
activity entries, rating math all handled for you). This is the default —
reach for it unless you specifically need a state the API can't produce.

```js
const round = await createRound(request);                 // a round + members
await request(app)                                        // add a game
  .post(`/api/rounds/${round.id}/games`)
  .field('title', 'Chess').field('minPlayers', '2').field('maxPlayers', '2');
```

Routes you'll typically chain (all under `/api/rounds/:rid/...`): `POST games`,
`POST sessions`, `POST sessions/:sid/results|choice|finish`, `POST games/:gid/retire`.
Grep `routes/*.js` for the exact shapes rather than guessing.

### Only reach into `store.data` when the API can't express the state

For edge cases (a malformed legacy record, a specific timestamp), you may mutate
the in-memory dataset directly — it's your throwaway copy. Mutate in place, never
reassign `data`, and call `saveData()` only if you need it on disk.

```js
const { store } = require('./helpers');
store.data.rounds.push({ id: 'r1', name: 'Seed', members: [], games: [] });
```

Don't denormalize computed values (e.g. rating averages) — those are derived on
demand from session votes; seed the votes, not the averages.

## Cleanup — throw the temp folder away

- **Inside `node --test`:** nothing to do. `helpers.js` creates the dir with
  `fs.mkdtempSync` under the OS temp dir, and the per-file process exits when the
  file finishes — the OS reclaims it. Do **not** add teardown that deletes the
  real `data/`.
- **In a standalone script or REPL you wrote yourself:** you own the temp dir, so
  remove it when done. Always target the temp path, never the project `data/`.

```js
const os = require('os'), fs = require('fs'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-sessions-scratch-'));
process.env.DATA_DIR = dir;              // BEFORE requiring the store/app
try {
  const { createApp } = require('./lib/app');
  // ... exercise createApp() against the isolated dataset ...
} finally {
  fs.rmSync(dir, { recursive: true, force: true });   // teardown
}
```

## Do / don't

- **Do** put scratch scripts and any exported fixtures under the session
  scratchpad or an OS temp dir, not in the repo.
- **Do** add/update a real `test/*.test.js` when you add a feature, and keep
  `npm test` green (see `.claude/rules/automated-tests.md`).
- **Don't** read, copy, or repoint at the production `data/` folder — ever.
- **Don't** delete a `data/`-shaped path in teardown without checking it's your
  temp dir; a stray `rm -rf` on the project `data/` destroys real data.
- **Don't** `git add` any generated data — `data/` is gitignored; keep it that way.
