# Add tests with new features; keep the suite green

There is an automated test suite: `npm test` (runs `node --test`, Node's built-in
runner — no framework, no build). Tests live in `test/*.test.js`; `supertest` is
the only test dependency and drives the Express app in-process (no port opened).

**Rule:** when you add or change a feature and a test is applicable, add or update
tests for it, and make sure `npm test` still passes before considering the work
done. The non-obvious parts below are why this is easy to get wrong:

- **Never call `app.listen()` in `lib/app.js`.** `lib/app.js` only *builds* the
  app (`createApp()`); `server.js` is the only place that listens. Tests require
  `lib/app.js` so they must not open a port. If you add middleware/routes, wire
  them in `createApp()`, not in `server.js`.

- **`DATA_DIR` must be set before the store is required.** `lib/store.js` reads
  `data.json` into memory *once at require-time*. A test that wants an isolated,
  empty dataset has to set `process.env.DATA_DIR` to a temp folder **before** the
  first `require('../lib/store')` (transitively via `lib/app.js`). Don't require
  the store/app at the top of a test and set `DATA_DIR` after — you'll get the
  real `data/` or an already-cached instance. Use `test/helpers.js`, which does
  this in the right order and exports a ready `app`. `node --test` runs each file
  in its own process, so each test file gets its own fresh temp dataset.

- **i18n parity is tested.** `test/i18n-parity.test.js` fails if `en.js` and
  `de.js` drift out of key parity or have an empty value — so adding a key to only
  one file will (correctly) break the suite. Add it to both.
