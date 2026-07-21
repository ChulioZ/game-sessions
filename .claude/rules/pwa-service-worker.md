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

- **Bump `CACHE` when any shell asset changes** *for the unbuilt path.* Assets are
  served **cache-first**, so a changed `styles.css`/`*.js` would be served stale
  until the cache version name changes. Bumping `CACHE` (`spieleabend-shell-vN`)
  re-precaches the shell and `activate` deletes the old cache. **Since #141** the
  optional production build (`npm run build`) content-hashes the js/css *and*
  rewrites the `SHELL` paths + the `CACHE` literal to a content-derived name, so a
  **built** deploy (`NODE_ENV=production`) self-invalidates and this manual bump is
  a no-op there. The manual `vN` bump only matters when serving the raw `public/`
  tree (dev / a non-prod deploy). See
  `.claude/rules/frontend-build-cache-busting.md`.

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

## Verifying a shell-asset change in a browser (the cache-first trap)

Because shell assets are served cache-first, editing `styles.css` or a
`public/js/*.js` and reloading keeps serving the **stale** bytes — even
`fetch(..., {cache:'reload'})` goes through the SW. Before believing any
in-browser check of a shell-asset change, unregister the SW and clear its
caches, then navigate fresh:

```js
(await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
(await caches.keys()).forEach(k => caches.delete(k));
```

The SW re-registers on the next load, so do this once per asset edit, not once
per session. Several rules reference this section — it is the one canonical
copy of the snippet.
