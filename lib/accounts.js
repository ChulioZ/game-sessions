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
 *  - Access token: short-lived, stateless, HMAC-SHA256-signed
 *    ("a1.<uid>.<expiryMs>.<hmac>") — verified without a DB hit.
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

const ACCESS_TOKEN_VERSION = 'a1';
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

const hmac = (value) =>
  crypto.createHmac('sha256', signingSecret()).update(value).digest('base64url');

// Random opaque token + its at-rest form. Only the hash is ever stored, so a
// leaked datastore doesn't leak usable tokens.
const newRawToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/* ------------------------------ access tokens ------------------------------ */

function mintAccessToken(userId, ttlMs = ACCESS_TTL_MS) {
  const payload = `${ACCESS_TOKEN_VERSION}.${userId}.${Date.now() + ttlMs}`;
  return `${payload}.${hmac(payload)}`;
}

// Returns the user id, or null when invalid/expired.
function verifyAccessToken(token) {
  if (!token || !signingSecret()) return null;
  const parts = String(token).split('.');
  if (parts.length !== 4) return null;
  const [ver, uid, expStr, sig] = parts;
  if (ver !== ACCESS_TOKEN_VERSION || !uid) return null;
  if (!safeEqual(sig, hmac(`${ver}.${uid}.${expStr}`))) return null;
  const exp = Number(expStr);
  return Number.isFinite(exp) && exp > Date.now() ? uid : null;
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

/* -------------------------------- middleware ------------------------------- */

// Bearer-token guard for account-scoped endpoints: sets req.userId or 401s.
// (Distinct from lib/auth.js requireAuth, which gates the whole instance.)
function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const uid = verifyAccessToken(token);
  if (!uid) return res.status(401).json({ error: 'invalid_token' });
  req.userId = uid;
  next();
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
  requireUser,
};
