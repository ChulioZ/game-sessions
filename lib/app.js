'use strict';

/*
 * Builds the Express app: middleware + route mounting only. No listening here,
 * so tests can require the app and drive it (e.g. via supertest) without opening
 * a port. server.js requires this and calls listen().
 */

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const path = require('path');

const { ROOT } = require('./store');
const { requestLogger, healthz, errorHandler } = require('./observability');
const auth = require('./auth');
const accounts = require('./accounts');
const mail = require('./mail');
const legal = require('./legal');
const { createCanonicalRedirect } = require('./canonical');
const storage = require('./storage');
const { assetsBuilt } = require('./status');
const { imageCspSources } = require('./providers');

const GLOBAL_WINDOW_MS = 15 * 60 * 1000; // 15 min

// Which directory holds the frontend assets. In production, prefer the optional
// content-hashed build (dist/, from `npm run build` — issue #141) when it's
// there; everywhere else (dev, tests) serve the live-editable public/ tree.
// Gating on NODE_ENV=production — not mere existence — keeps `npm start` and the
// test suite deterministic (a stale local dist/ never shadows your edits) while
// letting a production host serve the minified, hashed assets. A production run
// with no dist/ built falls back to public/ rather than 404ing.
// The condition itself lives in lib/status.js as assetsBuilt(), so the operator
// panel's "built assets" field (#274) reports what is genuinely being served
// rather than a second, drifting copy of this rule.
function assetDir() {
  return path.join(ROOT, assetsBuilt() ? 'dist' : 'public');
}

// Cache headers for static assets. Content-hashed build outputs (name.<8-hex>.js/
// .css from scripts/build.js, served from dist/ in production) are immutable —
// their URL changes when their bytes do — so browsers may cache them for a year.
// sw.js must instead revalidate on every fetch (no-cache) or a stale service
// worker would delay shell updates. Everything else keeps Express's default
// ETag revalidation. Exported for tests.
function assetCacheHeaders(res, filePath) {
  if (/\.[0-9a-f]{8}\.(js|css)$/.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (filePath.endsWith('sw.js')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
}

function createApp() {
  const app = express();
  const ASSET_DIR = assetDir();

  // Rate-limit ceilings, overridable via env so a deployment can tune them and a
  // test can drive tiny limits deterministically. Read per call (not at module
  // load) so each createApp() picks up the current env. `limit` is per IP/window.
  const globalLimit = Number(process.env.RATE_LIMIT_MAX) || 1000;
  const authLimit = Number(process.env.AUTH_RATE_LIMIT_MAX) || 20;
  const contactLimit = Number(process.env.CONTACT_RATE_LIMIT_MAX) || 5;

  // When behind a TLS-terminating reverse proxy (§4 of the roadmap: TLS lives at
  // the proxy), TRUST_PROXY tells Express to read the client IP from
  // X-Forwarded-For so rate limiting keys on the real caller. Left off by default
  // so a direct deployment can't be fooled by a spoofed header.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy)
      : trustProxy === 'true' ? true : trustProxy);
  }

  // Security headers. HSTS is set here (harmless over plain HTTP — browsers only
  // honour it over HTTPS, i.e. once TLS terminates at the proxy). The CSP keeps
  // helmet's safe defaults but: allows inline `style="…"` attributes (the views
  // build them for avatar colours, cover backgrounds, score pills) and `data:`
  // images (the background-grain SVG), and drops `upgrade-insecure-requests` so
  // the current plain-HTTP local deployment isn't forced onto HTTPS. img-src also
  // lists the provider cover hosts (derived from the providers' IMAGE_HOSTS, the
  // same set isAllowedImageUrl vouches for) so the browser can render provider
  // covers in the add-game/link previews and lookup thumbnails — and, since
  // #172, every SAVED cover too, because provider covers are hotlinked rather
  // than re-hosted. Drop a host and those games' covers silently go blank. See
  // .claude/rules/security-middleware.md and provider-cover-hotlinking.md.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', ...imageCspSources()],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'upgrade-insecure-requests': null,
      },
    },
  }));

  // Structured request logging (issue #132): one JSON line per request when it
  // finishes — method/path/status/timing/ip only, no bodies or query strings, so
  // no personal data is logged. Placed early so it also times rate-limited and
  // errored responses. Silence it with LOG_LEVEL=silent (the test suite does).
  app.use(requestLogger);

  // Canonical-host redirect (issue #230): 301 the branded non-canonical domains
  // (spielwirbel.de/.com + www) onto spielwirbel.app, so all traffic converges on
  // one origin. An allowlist — it never touches the canonical host, Railway's
  // *.up.railway.app, or the deploy health-check host, so health-checks don't
  // flap. Built here so it reads the current env; a no-op on local/test hosts.
  // See lib/canonical.js and .claude/rules/canonical-host-redirect.md.
  app.use(createCanonicalRedirect());

  // gzip responses (perf for the hosted deploy): round JSON compresses ~8-10x,
  // which directly cuts API latency and transfer. The middleware only compresses
  // compressible content-types, so image bytes from /uploads pass through
  // untouched, and responses under its 1 KB threshold are skipped.
  app.use(compression());

  // Health/readiness probe, before the rate limiter so uptime monitors polling
  // it frequently are never throttled.
  app.get('/healthz', healthz);

  // Global rate limit: a blunt DoS/abuse cap across the whole app. The ceiling is
  // generous so normal browsing (assets are browser-cached after first load)
  // never trips it.
  app.use(rateLimit({
    windowMs: GLOBAL_WINDOW_MS,
    limit: globalLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  }));

  app.use(express.json());

  // Auth gate (issue #129). Active only when AUTH_PASSWORD is set; otherwise
  // every guard below is a no-op and the app stays open (current MVP). The login
  // endpoints mount first, ahead of the gate, so they stay reachable without a
  // session; a stricter limiter fronts them against password brute-forcing.
  const authLimiter = rateLimit({
    windowMs: GLOBAL_WINDOW_MS,
    limit: authLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  });
  app.use('/api/auth', authLimiter, require('../routes/auth'));

  // User accounts (issue #135): register/login/refresh/reset, token-first.
  // Mounted ahead of the shared-password gate (account auth must be reachable
  // without an instance session) behind the same strict limiter — but the whole
  // router 404s unless ACCOUNTS_ENABLED + SESSION_SECRET are set, so a
  // deployment that hasn't opted in exposes nothing new.
  app.use('/api/account', authLimiter, require('../routes/account'));

  // Public contact form (issue #224): mounted ahead of the gate so an
  // unauthenticated visitor can reach it (the phone-free §5 DDG second channel).
  // Its own low limiter (CONTACT_RATE_LIMIT_MAX, default 5/window) blunts spam;
  // the server-side honeypot in the route rejects bots without a signal.
  const contactLimiter = rateLimit({
    windowMs: GLOBAL_WINDOW_MS,
    limit: contactLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  });
  app.use('/api/contact', contactLimiter, require('../routes/contact'));

  // Public, non-sensitive feature flags for the static frontend (#224/#134).
  // The shell is plain static files, so the client cannot see env — this is the
  // one place it may ask "which optional public surfaces are on?". `footer` is
  // deliberately all-or-nothing: the shared site footer holds the Kontakt link
  // (useless until mail can deliver) and the legal pages (404 until the
  // Impressum identity exists — lib/legal.js), and a partially populated
  // public face reads as broken. `donateUrl` (#173) is the operator's donation
  // page; null hides the support button entirely — absent config means the
  // feature does not exist, so self-hosted instances never advertise the
  // operator's page. Values are read per request like every other env ceiling
  // in this file; mounted ahead of the auth gates because the footer renders
  // on the login page too and the support button must work for a logged-out
  // visitor in accounts mode. Never put anything sensitive in this response.
  app.get('/api/config', (req, res) => {
    const donate = (process.env.DONATE_URL || '').trim();
    res.json({
      footer: mail.isConfigured() && legal.legalConfigured(),
      donateUrl: donate || null,
    });
  });

  // Impressum + Datenschutzerklärung (issue #134): public, login-free,
  // server-rendered with the operator identity from env; 404 until configured.
  app.use(require('../routes/legal'));

  // Operator moderation surface (issue #268): image lookup, takedown, account
  // suspension, action log. Mounted ahead of the app's gate for the same reason
  // as the routers above — the operator must reach it in either auth mode — and
  // behind the same strict limiter, since it takes a password. It carries its
  // own, separate gate (lib/admin.js / ADMIN_PASSWORD) and the whole router 404s
  // unless that is configured, so an instance that hasn't opted in exposes
  // nothing. The tenant middleware below deliberately does NOT apply: moderation
  // is cross-tenant by definition (see .claude/rules/admin-moderation-surface.md).
  app.use('/api/admin', authLimiter, require('../routes/admin'));

  // Static app shell + assets stay open (they hold no user data — just the code
  // that's public on the repo anyway); the real protection is on the data below.
  // `index: false` so `/` doesn't shortcut to index.html via static — it falls
  // through to the SPA fallback, which can serve the login page when locked.
  app.use(express.static(ASSET_DIR, { index: false, setHeaders: assetCacheHeaders }));
  // Cover images ARE user data, so gate /uploads (a session/account cookie rides
  // along on same-site <img> GETs). In accounts mode (#138) a valid account token
  // — Bearer header or the lax access cookie — is required; otherwise the shared
  // gate applies (a no-op when auth is disabled). The storage backend serves the
  // bytes — off local disk by default, streamed from object storage when S3 is
  // configured (issue #128) — behind this same gate.
  app.use('/uploads', (req, res, next) =>
    (accounts.accountsEnabled() ? accounts.requireUploadAccount : auth.requireAuth)(req, res, next), storage.serve);

  // Gate every data route: /api/auth and /api/account already handled their own
  // paths above, so this protects all the resource routers that follow (401 when
  // locked out). In accounts mode (#138) a valid account Bearer token is required
  // — there is no anonymous 'default' access — otherwise the shared-password gate
  // applies (a no-op when auth is disabled). Both answer 401 'auth_required' so
  // the SPA's api() reacts identically.
  app.use('/api', (req, res, next) =>
    (accounts.accountsEnabled() ? accounts.requireApiAccount : auth.requireAuth)(req, res, next));

  // Tenancy (issue #136): resolve the caller's tenant once and hand every
  // resource router a repo scoped to it (req.repo) — the single enforcement
  // point for data isolation. Mounted after the gate so only authenticated
  // requests reach it.
  app.use('/api', require('./tenant').withTenant);

  // API routes (split by resource). In-app feedback (issue #260) used to mount
  // its own POST /api/feedback here; since #321 feedback is submitted through the
  // public contact form (routes/contact.js, category 'feedback') and this route
  // is retired. The operator read side stays on /api/admin (routes/admin.js).
  app.use('/api/rounds', require('../routes/rounds'));
  app.use('/api/rounds/:rid/games', require('../routes/games'));
  app.use('/api/rounds/:rid/members', require('../routes/members'));
  app.use('/api/rounds/:rid/sessions', require('../routes/sessions'));
  app.use('/api/rounds/:rid/activities', require('../routes/activities'));
  app.use('/api/rounds/:rid/background', require('../routes/background'));
  app.use('/api/rounds/:rid/tags', require('../routes/tags'));
  app.use('/api/rounds/:rid/providers', require('../routes/providers'));
  // Round-scoped since #294: the enabled-provider list is a property of the
  // round, so the lookup needs to know which round is asking.
  app.use('/api/rounds/:rid/lookup', require('../routes/lookup'));

  // SPA fallback: serve the app shell for frontend GET navigations (deep links,
  // reloads) that aren't an API call, an upload, or a real static file — the
  // client-side router (public/js/router.js) then renders the matching view.
  // Placed last so express.static and the /api routers take precedence; unknown
  // /api/* paths fall through to Express's default 404 rather than the shell.
  app.get(/(.*)/, (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
    if (!req.accepts('html')) return next();
    // Pass the file relative to a `root`, not as an absolute path: res.sendFile
    // rejects (404s) any path segment starting with a dot, and an absolute path
    // includes the whole prefix — so running from a directory like a
    // `.claude/worktrees/…` checkout would otherwise fail. With `root`, only the
    // relative part ('index.html') is checked for dotfiles.
    const root = ASSET_DIR;
    // In accounts mode (#138) always serve the SPA: the client renders the auth
    // UI and logs in via /api/account, while the data routes above stay
    // token-gated — so an unauthenticated visitor still gets no round data.
    if (accounts.accountsEnabled()) {
      return res.sendFile('index.html', { root });
    }
    // Gate the SPA shell (issue #129): when locked and unauthenticated, serve the
    // standalone login page instead of the app, so an unauthenticated visitor
    // never receives the round data-bearing UI.
    if (auth.authEnabled() && !auth.isAuthenticated(req)) {
      return res.sendFile('login.html', { root });
    }
    res.sendFile('index.html', { root });
  });

  // Central error handler (issue #132): must be last. Any unexpected throw or
  // next(err) — including async rejections, which Express 5 forwards here — is
  // logged + optionally alerted and answered with a generic 500, so stack traces
  // never leak to the client. See lib/observability.js.
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, assetCacheHeaders };
