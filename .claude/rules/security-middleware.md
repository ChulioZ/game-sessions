# helmet CSP + rate limiting gotchas (lib/app.js)

Security headers (`helmet`) and rate limiting (`express-rate-limit`) are wired in
`createApp()` (issue #130). Two things are non-obvious and cost effort:

- **Don't let helmet's default CSP emit `upgrade-insecure-requests`.** helmet's
  default CSP includes it, which tells the browser to upgrade every request to
  HTTPS. The app currently runs plain **HTTP** locally, so that directive breaks
  same-origin asset loading. We drop it (`'upgrade-insecure-requests': null`).
  Also keep **`style-src 'unsafe-inline'`** and **`img-src … data:`**: the views
  build inline `style="…"` attributes (avatar colours, cover `background-image`,
  score pills) and the background grain is a `data:` SVG — a stricter CSP blanks
  those with no JS error, only a silent CSP violation in the console.

- **`img-src` also lists the provider cover hosts, derived from the providers'
  `IMAGE_HOSTS` (issue #179).** `lib/app.js` spreads
  `require('./providers').imageCspSources()` into `img-src` so the browser may
  **render** the same hosts the server is allowed to **download** from
  (`isAllowedImageUrl`) — one source of truth for "hosts we trust for covers".
  Without it, every provider cover is cross-origin and CSP-blocked, so the
  add-game preview, the link-provider cover preview, and the lookup dropdown
  thumbnails silently show nothing (only a CSP violation in the console). Each
  provider's download guard accepts a host `h` **and any subdomain**
  (`host === h || host.endsWith('.' + h)`), so `imageCspSources()` emits both the
  bare `h` and a `*.h` wildcard (a lone `*.h` doesn't match the apex). Keep it
  derived — add a provider's hosts to its `IMAGE_HOSTS` and both the download
  allowlist and the CSP stay in sync; don't re-hardcode hosts in `lib/app.js`.
  `test/security.test.js` asserts every `imageCspSources()` entry is on `img-src`.
  Note this is *not* a widening to arbitrary hosts — it's exactly the download
  allowlist (no wildcards to third parties). A same-origin image proxy is the
  tighter alternative for a hardened hosted deploy; deferred to the hosting work.

- **Read the rate-limit ceilings *inside* `createApp()`, not at module load.**
  `const LIMIT = Number(process.env.RATE_LIMIT_MAX)` at the top of `lib/app.js`
  binds once at require-time, so a test that sets the env var later (or
  `test/helpers.js` raising it) has no effect and the limiter can't be driven
  deterministically. Read `process.env.RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX`
  per call so each `createApp()` picks up the current env and gets its own
  in-memory limiter store. `test/helpers.js` raises the ceilings to ~1e6 so the
  ordinary suite never trips them; `test/security.test.js` builds fresh apps with
  tiny limits to assert the 429s.

**Why the suite is structured this way:** the limiter store is per-app-instance
and per-process. `node --test` isolates files, but *within* a file the shared
`app` from helpers is reused across every request — a low ceiling there would
make unrelated tests flake once they exceed it (a single spec can issue dozens
of requests). Hence: raise limits on the shared app, test the limiter on
throwaway apps.
