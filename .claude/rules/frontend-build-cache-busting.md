# The optional cache-busting build (scripts/build.js, #141) — gotchas

Issue #141 added the app's one sanctioned build step: `npm run build`
(`scripts/build.js`, using `esbuild`) mirrors `public/` into `dist/` with
**content-hashed, minified** `js/**` + `styles.css`, rewriting every reference in
`index.html`, `sw.js` and `login.html`. It exists purely to bust stale asset
caches after a deploy — it is **not** a bundler/framework, and dev stays
build-free. Non-obvious things that will bite if you forget them:

- **NEVER rename identifiers, never bundle.** The frontend scripts share ONE
  global scope across files in a fixed load order (see
  `frontend-script-load-order.md`). So `build.js` minifies each file with
  `minifyWhitespace`/`minifySyntax` but **`minifyIdentifiers: false`**, via
  `esbuild.transformSync` (per file), never `esbuild.build`/bundling. Renaming a
  top-level name (`showHome`, `THEMES`, …) or merging files would break the
  cross-file references and the load order. `test/build.test.js` spot-checks that
  known globals survive minification. (esbuild won't DCE apparently-unused
  top-level names in a *script* either — they're global — but keep identifiers
  off regardless.)

- **`dist/` is served only under `NODE_ENV=production`**, not on mere existence.
  `assetDir()` in `lib/app.js` returns `dist/` only when
  `NODE_ENV==='production'` **and** `dist/index.html` exists, else `public/`. This
  is deliberate: gating on existence would make `npm test`/`npm start` serve a
  **stale local `dist/`** that silently shadows your `public/` edits, and would
  make the test suite non-deterministic (e.g. the pwa test asserts the exact
  `/js/pwa.js` path, which a built tree hashes). A production run with no `dist/`
  falls back to `public/` rather than 404ing. To go back to live editing: `rm -rf
  dist` (or just don't set `NODE_ENV=production`).

- **Reference rewriting is delimited-path replacement.** `rewriteRefs` only
  replaces a mapped path when it's wrapped in matching quotes (`"…"`/`'…'`), so
  `/js/views-round.js` can't clobber `/js/views-round-tabs.js` as a substring.
  Only `public/js/**` + `styles.css` are in the manifest; **fonts, icons,
  `manifest.webmanifest`, `fonts/tabler-icons.css` and `index.html` itself are
  copied through unchanged** (index.html is the bootstrap document — it can't be
  content-hashed). `.DS_Store` and other dotfiles are skipped in the mirror.

- **The built `sw.js` gets a content-derived `CACHE`.** `deriveCache` hashes the
  set of hashed filenames, so a built deploy self-invalidates the service-worker
  shell cache; the manual `spieleabend-shell-vN` bump in the *source* `sw.js` only
  matters for the unbuilt path (see `pwa-service-worker.md`). The `SHELL`↔
  `index.html` parity the pwa test guards is about the **source** files; the build
  derives the built `SHELL` from them.

- **`esbuild` is a `devDependency`** (its postinstall fetches a platform binary;
  CI's `npm ci` handles that). `test/build.test.js` runs the *real* build into a
  temp dir (no network, no touching the repo's `dist/`) and asserts the output is
  self-consistent — that's the CI smoke test that the build still works. ESLint
  ignores `dist/**` and `check:syntax` prunes `./dist`, so a local build never
  trips lint/syntax.

**Why:** un-hashed static assets serve stale JS/CSS after a deploy (the
"hard-refresh to fix" class of bug). Content-hashing changes the URL when the
bytes change, so a fresh load never asks for the stale file. Kept optional and
production-gated so the no-build-step dev flow (CLAUDE.md) is untouched.
