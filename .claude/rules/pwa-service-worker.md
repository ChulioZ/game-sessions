# The PWA service worker (public/sw.js) — gotchas

Issue #142 made the app installable + offline with a plain, no-build service
worker (`public/sw.js`), a web manifest (`public/manifest.webmanifest`), a tiny
registration IIFE (`public/js/pwa.js`), and home-screen icons (`public/icons/`).
Non-obvious things that will bite if you forget them:

- **The `SHELL` precache list must stay in sync with `index.html`.** `install`
  calls `cache.addAll(SHELL)`, which **rejects on any single 404** — so if you
  rename/add/remove a `public/js/*.js` (and update the `<script>` tags), update
  `SHELL` too, or the SW silently fails to install (no offline, no error the user
  sees). `test/pwa.test.js` guards this: it parses `SHELL` out of `sw.js` and
  asserts every entry is actually served.

- **Bump `CACHE` when any shell asset changes.** Assets are served **cache-first**
  and filenames are **not** content-hashed yet (that's the separate #141), so a
  changed `styles.css`/`*.js` would be served stale until the cache version name
  changes. Bumping `CACHE` (`spieleabend-shell-vN`) re-precaches the shell and
  `activate` deletes the old cache. (No deploy pipeline exists yet — #131 — so
  this is forward-looking, but it's the one manual step a deploy must remember.)

- **Never cache `/api/` or `/uploads/`.** The fetch handler skips both: API
  responses are live data, and `/uploads/` is auth-gated user cover art (#129).
  Caching either would serve stale/leaked data offline.

- **Navigations are network-first on purpose.** So an online visit always hits the
  server, which decides the auth gate (#129) — only *offline* do we serve the
  cached shell. Don't switch navigations to cache-first, or a locked instance
  could show the app shell from cache to an unauthenticated visitor.

- **`public/sw.js` needs its own ESLint block.** It runs in the
  `ServiceWorkerGlobalScope` (`self`, `caches`, `clients`, …), and it lives
  *outside* `public/js/**`, so the frontend override doesn't cover it.
  `eslint.config.js` has a dedicated `files: ['public/sw.js']` block with
  `globals.serviceworker`; without it `no-undef` flags `self`/`caches`.

- **Icons are generated, committed PNGs.** There's no image tooling in the repo;
  the icons were rasterized once (a white die on the brand `#c2410c`) and
  committed as static files. Regenerate with a script if the brand changes; don't
  add an image build step just for icons.
