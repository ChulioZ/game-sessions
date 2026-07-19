'use strict';

/*
 * User-account primitives (issue #135) — the token-first account layer that will
 * eventually replace the shared-password gate (lib/auth.js) once tenancy (#136)
 * and onboarding (#138) land. Until then the two coexist: lib/auth.js keeps
 * gating the single instance's data, while this module powers /api/account.
 *
 * Feature-gated: everything is inert unless ACCOUNTS_ENABLED=true AND a
 * SESSION_SECRET is configured (the secret signs access tokens; an empty secret
 * would make them forgeable, so enabling without one stays off). Deliberately
 * NOT falling back to AUTH_PASSWORD like the gate does — the shared password is
 * known to the whole group and must not be able to forge per-user tokens.
 *
 * Token model (token-first per roadmap §5, so web and the later native apps
 * share one auth; the OAuth/PKCE redirect flow only matters when social login
 * arrives — the identities seam below leaves room for it):
 *  - Access token: short-lived, stateless JWT (HS256, signed with SESSION_SECRET
 *    via the vetted `jsonwebtoken` library, not hand-rolled HMAC) — carries the
 *    user id as the `sub` claim, verified without a DB hit.
 *  - Refresh token: long-lived, opaque ("r1.<uid>.<random>"), stored ONLY as a
 *    SHA-256 hash on the user, rotated on every use, revocable.
 *  - Verification/reset tokens: opaque randoms, hashed at rest, time-limited,
 *    single-use.
 *
 * Passwords are hashed with Argon2id (the `argon2` library — vetted primitives,
 * no hand-rolled crypto). A user's `identities` array holds the credential
 * providers (only { type: 'password', hash } today; 'apple'/'google' later), so
 * adding social sign-in extends the array instead of reshaping the user.
 *
 * Config is read per call (not at module load) so tests and createApp() always
 * see the current env — same reason as lib/auth.js and the rate-limit ceilings.
 */

const crypto = require('crypto');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');

const REFRESH_TOKEN_VERSION = 'r1';
const ACCESS_TTL_MS = 15 * 60 * 1000; // 15 min
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const RESET_TTL_MS = 60 * 60 * 1000; // 1 h
const MAX_REFRESH_TOKENS = 10; // sessions kept per user (oldest evicted)

function signingSecret() {
  return process.env.SESSION_SECRET || '';
}

function accountsEnabled() {
  return process.env.ACCOUNTS_ENABLED === 'true' && !!signingSecret();
}

/* ------------------------------ small crypto ------------------------------- */

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Random opaque token + its at-rest form. Only the hash is ever stored, so a
// leaked datastore doesn't leak usable tokens.
const newRawToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/* ------------------------------ access tokens ------------------------------ */

// A standard HS256 JWT signed with SESSION_SECRET: the user id rides in the `sub`
// claim, the TTL in `exp`. `exp` is set explicitly (rather than via jsonwebtoken's
// `expiresIn` option) so the ttlMs contract maps straight through — including the
// negative TTL the tests use to mint an already-expired token.
function mintAccessToken(userId, ttlMs = ACCESS_TTL_MS) {
  const exp = Math.floor((Date.now() + ttlMs) / 1000);
  return jwt.sign({ sub: String(userId), exp }, signingSecret(), { algorithm: 'HS256' });
}

// Returns the user id (the `sub` claim), or null when the token is
// missing/tampered/expired or no signing secret is configured. Pinning
// `algorithms: ['HS256']` rejects `alg: none` and algorithm-confusion attacks.
function verifyAccessToken(token) {
  const secret = signingSecret();
  if (!token || !secret) return null;
  try {
    const { sub } = jwt.verify(String(token), secret, { algorithms: ['HS256'] });
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}

/* ------------------------------ refresh tokens ----------------------------- */

// The user id rides inside the (otherwise opaque) refresh token so the API can
// stay standard — clients send just { refreshToken }, no separate user id.
function mintRefreshToken(userId) {
  return `${REFRESH_TOKEN_VERSION}.${userId}.${newRawToken()}`;
}

// Split a refresh token into { userId, hash } for lookup, or null if malformed.
function parseRefreshToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== REFRESH_TOKEN_VERSION || !parts[1]) return null;
  return { userId: parts[1], hash: hashToken(parts[2]) };
}

// Next refreshTokens list after adding `entry`: expired ones dropped, capped to
// MAX_REFRESH_TOKENS by evicting the oldest.
function pushRefreshToken(list, entry) {
  const now = Date.now();
  const kept = (list || []).filter((t) => Date.parse(t.expiresAt) > now);
  kept.push(entry);
  kept.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return kept.slice(-MAX_REFRESH_TOKENS);
}

/* -------------------------------- passwords -------------------------------- */

const hashPassword = (password) => argon2.hash(password, { type: argon2.argon2id });
const verifyPassword = (hash, password) => argon2.verify(hash, password).catch(() => false);

// Verified against when the login email matches no account, so the request
// spends the same Argon2 work either way (no timing-based user enumeration).
const DUMMY_HASH_PROMISE = hashPassword('dummy-timing-equalizer');

/* ------------------------------- request auth ------------------------------ */

// The access token also rides in a cookie (set on login/refresh) so that
// browser-native GETs — cover <img>/background-image on /uploads — authenticate,
// which can't carry an Authorization header. fetch/XHR use the Bearer header.
// The cookie is sameSite=lax and only honored for the read-only /uploads gate, so
// state-changing /api requests stay Bearer-only and immune to CSRF (see lib/app.js).
const ACCESS_COOKIE = 'sa';

const bearerToken = (req) => {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
};

// Read one cookie from the raw header (Express 5 doesn't parse cookies, and we
// avoid cookie-parser just to read one name — same approach as lib/auth.js).
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

// `secure: req.secure` marks the cookie Secure only once TLS terminates in front
// (true behind a trusted proxy sending X-Forwarded-Proto=https) — so plain-HTTP
// local dev keeps it. Mirrors lib/auth.js cookieOptions.
const accessCookieOptions = (req) => ({ httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
function setAccessCookie(res, req, token) {
  res.cookie(ACCESS_COOKIE, token, { ...accessCookieOptions(req), maxAge: ACCESS_TTL_MS });
}
function clearAccessCookie(res, req) {
  res.clearCookie(ACCESS_COOKIE, accessCookieOptions(req));
}

/* -------------------------------- middleware ------------------------------- */

// Bearer-token guard for account-scoped endpoints: sets req.userId or 401s.
// (Distinct from lib/auth.js requireAuth, which gates the whole instance.)
function requireUser(req, res, next) {
  const uid = verifyAccessToken(bearerToken(req));
  if (!uid) return res.status(401).json({ error: 'invalid_token' });
  req.userId = uid;
  next();
}

// Gate for the /api data routes when accounts are enabled: a valid Bearer access
// token is REQUIRED (no anonymous 'default' access), and ONLY the header is
// honored — never the cookie — so a cross-site form can't attach it and
// state-changing requests stay immune to CSRF. 401 (auth_required) otherwise, so
// the SPA's api() can refresh-or-bounce-to-login exactly like the shared gate.
function requireApiAccount(req, res, next) {
  if (verifyAccessToken(bearerToken(req))) return next();
  return res.status(401).json({ error: 'auth_required' });
}

// Gate for GET /uploads (cover images) when accounts are enabled: the access
// token via the Bearer header OR the cookie, since image requests can't send a
// header. The cookie is sameSite=lax (a cross-site subresource can't ride it) and
// /uploads is read-only, so honoring it here adds no CSRF exposure.
function requireUploadAccount(req, res, next) {
  if (verifyAccessToken(bearerToken(req) || readCookie(req, ACCESS_COOKIE))) return next();
  return res.status(401).json({ error: 'auth_required' });
}

module.exports = {
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  VERIFY_TTL_MS,
  RESET_TTL_MS,
  MAX_REFRESH_TOKENS,
  accountsEnabled,
  safeEqual,
  newRawToken,
  hashToken,
  mintAccessToken,
  verifyAccessToken,
  mintRefreshToken,
  parseRefreshToken,
  pushRefreshToken,
  hashPassword,
  verifyPassword,
  DUMMY_HASH_PROMISE,
  ACCESS_COOKIE,
  bearerToken,
  setAccessCookie,
  clearAccessCookie,
  requireUser,
  requireApiAccount,
  requireUploadAccount,
};
