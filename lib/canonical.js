'use strict';

/*
 * Canonical-host redirect (issue #230).
 *
 * The app is reachable at several branded domains — spielwirbel.de/.com and
 * their www — plus the canonical spielwirbel.app. All of them are custom domains
 * on ONE Railway service backed by ONE Postgres database, so this redirect is
 * purely about funnelling everyone onto a single origin (one address to
 * share/bookmark, one PWA install, one per-origin login/localStorage, no
 * duplicate-content SEO split) — it is NOT about data routing; every host serves
 * the identical database.
 *
 * It is an ALLOWLIST on purpose: only the explicitly branded non-canonical hosts
 * are redirected. The canonical host itself, Railway's own `*.up.railway.app`
 * domain, `localhost`/test hosts, and — critically — the deploy health-check
 * host (`Host: healthcheck.railway.app`) all fall through untouched. Redirecting
 * the health-check would 301 Railway's probe and flap every deploy. See
 * `.claude/rules/canonical-host-redirect.md`.
 */

const DEFAULT_CANONICAL = 'spielwirbel.app';
const DEFAULT_REDIRECT_HOSTS = [
  'spielwirbel.de', 'www.spielwirbel.de',
  'spielwirbel.com', 'www.spielwirbel.com',
];

// Parse a comma-separated host list from env; an unset var falls back to the
// default set, while an explicit empty string yields [] (redirect nothing).
function parseHosts(raw, fallback) {
  if (raw == null) return fallback;
  return raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

// Build the middleware once per createApp() so it reads the current env — mirrors
// how lib/app.js reads its rate-limit ceilings per call (a test can then drive
// hosts deterministically). Env: CANONICAL_HOST, REDIRECT_HOSTS.
function createCanonicalRedirect() {
  const canonical = canonicalHost();
  const hosts = new Set(redirectHosts());

  return function canonicalRedirect(req, res, next) {
    // Inert when misconfigured (no canonical target, or nothing to redirect) so a
    // local/test run — never on a branded host anyway — is a pure no-op.
    if (!canonical || hosts.size === 0) return next();
    // req.hostname strips the port and honours X-Forwarded-Host under trust proxy
    // (Railway terminates TLS in front). Only the branded non-canonical hosts
    // match; everything else (canonical, *.up.railway.app, healthcheck.railway.app,
    // localhost) passes through.
    const host = (req.hostname || '').toLowerCase();
    if (!host || host === canonical || !hosts.has(host)) return next();
    // Permanent redirect to the same path + query on the canonical host, always
    // https (canonical .app is HSTS-preloaded → HTTPS-only). req.originalUrl keeps
    // the full path and query string.
    return res.redirect(301, `https://${canonical}${req.originalUrl}`);
  };
}

// Resolved per call, and exported so the operator status card (#274) reports the
// SAME hosts this middleware actually acts on rather than re-deriving them from
// env and drifting. createCanonicalRedirect() above uses them too, so there is
// one derivation, not two.
function canonicalHost() {
  return (process.env.CANONICAL_HOST || DEFAULT_CANONICAL).trim().toLowerCase();
}

function redirectHosts() {
  return parseHosts(process.env.REDIRECT_HOSTS, DEFAULT_REDIRECT_HOSTS);
}

module.exports = {
  createCanonicalRedirect,
  canonicalHost,
  redirectHosts,
  DEFAULT_CANONICAL,
  DEFAULT_REDIRECT_HOSTS,
};
