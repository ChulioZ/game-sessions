# Canonical-host redirect must be an allowlist (or it flaps the Railway deploy)

Issue #230 added a canonical-host 301 (`lib/canonical.js`, wired in `lib/app.js`):
the branded domains `spielwirbel.de`/`.com` (and their `www`) redirect to the
canonical `spielwirbel.app`. All these domains are custom domains on **one**
Railway service + **one** Postgres DB, so the redirect is about converging on a
single origin (shared bookmarks, one PWA install, one per-origin
login/localStorage, no duplicate-content SEO) — **not** data routing. Every host
already serves the identical database; nothing is migrated.

**The non-obvious trap — keep the allowlist:** the middleware redirects **only**
an explicit set of branded hosts. It deliberately does **not** do the tempting
inverse ("redirect anything that isn't `spielwirbel.app`"), because Railway's
**deploy health-check sends its probe with `Host: healthcheck.railway.app`**. An
inverse rule would 301 that probe → the health-check never sees 200 → Railway
marks the deploy unhealthy and restart-loops it. The same would hit the service's
own `*.up.railway.app` domain and any future internal caller.

So the rule is: **only known branded non-canonical hosts redirect; the canonical
host, `*.up.railway.app`, the health-check host, and localhost/test hosts all
fall through untouched.** `test/canonical.test.js` asserts exactly this — in
particular that `Host: healthcheck.railway.app` gets a 200, not a 301.

Other things baked in:

- **Env-driven, read per `createApp()`** (`CANONICAL_HOST`, `REDIRECT_HOSTS`),
  mirroring how `lib/app.js` reads its rate-limit ceilings per call — so a test
  can drive hosts deterministically and a live re-tune needs no code change. An
  empty `REDIRECT_HOSTS` makes it inert. Defaults are the branded set + `.app`,
  so local/test runs (never on a branded host) are a pure no-op and the rest of
  the suite is unaffected.
- **`req.hostname`, not the raw `Host` header** — it strips the port and honours
  `X-Forwarded-Host` under `trust proxy` (Railway terminates TLS in front, so the
  app sees the forwarded host). Matching is lowercased.
- **Always redirects to `https://`** — the canonical `.app` TLD is HSTS-preloaded
  (HTTPS-only in every browser), so an `http://` target would be pointless.
- **Mounted early** (after helmet + request logging, before the rate limiter and
  static) so a branded-host hit is redirected cheaply and the 301 still carries
  security headers and is logged.
