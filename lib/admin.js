'use strict';

/*
 * Operator (admin) gate for the moderation surface — issue #268.
 *
 * Guards /api/admin and the standalone /admin.html page: the tooling an operator
 * needs to act on an abuse notice (locate a cover image, take it down, suspend an
 * account, read the action log). See routes/admin.js.
 *
 * This deliberately MIRRORS lib/auth.js's mechanism (one shared password ->
 * stateless HMAC-signed httpOnly cookie, Node `crypto` only, no session store, no
 * new dependency) but does NOT reuse its secret. Two reasons, both real:
 *
 *  1. AUTH_PASSWORD is shared with the whole group that uses the instance. These
 *     powers cross tenant boundaries (read any tenant's rows, delete any image,
 *     disable any account), so granting them to everyone holding the app password
 *     would be a privilege escalation. This is the same call
 *     .claude/rules/user-accounts.md already made for SESSION_SECRET, which must
 *     not fall back to AUTH_PASSWORD "because the shared password is known to the
 *     whole group".
 *  2. Sharing the secret would make an ordinary app session token verify as an
 *     admin token, so in legacy (shared-password) mode the panel would have no
 *     separate gate at all.
 *
 * Hence a separate ADMIN_PASSWORD, a separate cookie name, and — so a shared
 * SIGNING secret still can't let one token stand in for the other — a
 * domain-separated HMAC payload ('admin.' prefix) plus its own token version.
 *
 * Fail-closed: with no ADMIN_PASSWORD configured the whole surface 404s
 * (requireAdmin below), exactly like accounts.accountsEnabled() gates the account
 * routes. An instance that never sets it is byte-for-byte unchanged.
 *
 * All config is read per call (not at module load) so each createApp()/request
 * sees the current env — same reason as lib/auth.js and the rate-limit ceilings
 * (.claude/rules/security-middleware.md).
 */

const crypto = require('crypto');

const COOKIE_NAME = 'aid';
const TOKEN_VERSION = 'a1';
// Deliberately much shorter than the app session's 30 days: a privileged surface
// used rarely, so a stolen/forgotten cookie has a small window.
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// The admin surface exists only when an operator password is configured.
function adminEnabled() {
  return !!(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length);
}

// Secret signing the admin session token. Prefer an explicit
// ADMIN_SESSION_SECRET, then the app's SESSION_SECRET, else the admin password
// itself (so a minimal deployment can set just ADMIN_PASSWORD). Sharing
// SESSION_SECRET is safe here only because the payload is domain-separated
// below — never drop that prefix.
function signingSecret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
}

// Constant-time compare (timingSafeEqual requires equal length).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// The 'admin.' prefix is the domain separator: an app token (lib/auth.js signs a
// bare "v1.<exp>") can never produce a matching signature here even when both
// modules resolve to the same SESSION_SECRET.
function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(`admin.${value}`).digest('base64url');
}

// token = "a1.<expiryMs>.<hmac('admin.a1.<expiryMs>')>" — self-contained.
function mintToken(secret, ttlMs = TOKEN_TTL_MS) {
  const payload = `${TOKEN_VERSION}.${Date.now() + ttlMs}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [ver, expStr, sig] = parts;
  if (ver !== TOKEN_VERSION) return false;
  if (!safeEqual(sig, sign(`${ver}.${expStr}`, secret))) return false;
  const exp = Number(expStr);
  return Number.isFinite(exp) && exp > Date.now();
}

// Read one cookie from the raw header (Express 5 doesn't parse cookies and we
// don't add cookie-parser just to read one name — same as lib/auth.js).
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function isAdmin(req) {
  if (!adminEnabled()) return false;
  return verifyToken(readCookie(req, COOKIE_NAME), signingSecret());
}

function passwordMatches(candidate) {
  const expected = process.env.ADMIN_PASSWORD || '';
  return !!expected && typeof candidate === 'string' && safeEqual(candidate, expected);
}

// `secure: req.secure` marks the cookie Secure once TLS terminates in front (true
// behind a trusted proxy sending X-Forwarded-Proto=https — see TRUST_PROXY in
// lib/app.js); over plain-HTTP local dev it stays unset so the browser and
// supertest keep the cookie. sameSite 'strict' (not 'lax' like the app session):
// nothing should ever navigate into the admin surface from another origin.
function cookieOptions(req) {
  return { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' };
}

function setSession(req, res) {
  res.cookie(COOKIE_NAME, mintToken(signingSecret()), {
    ...cookieOptions(req),
    maxAge: TOKEN_TTL_MS,
  });
}

function clearSession(req, res) {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
}

// Middleware for every admin route except login: 404 when the surface is
// disabled (don't advertise its existence), 401 when it's on but unauthenticated.
function requireAdmin(req, res, next) {
  if (!adminEnabled()) return res.status(404).json({ error: 'admin_disabled' });
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'admin_auth_required' });
}

module.exports = {
  COOKIE_NAME,
  TOKEN_TTL_MS,
  adminEnabled,
  signingSecret,
  mintToken,
  verifyToken,
  isAdmin,
  passwordMatches,
  setSession,
  clearSession,
  requireAdmin,
};
