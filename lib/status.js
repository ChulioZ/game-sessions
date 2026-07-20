'use strict';

/*
 * Instance status for the operator panel (issue #274).
 *
 * Answers "how is this running instance ACTUALLY configured?" so #219's go-live
 * checklist can be verified from the app instead of by reading Railway's
 * env-var list and hoping. Every quiet misconfiguration it reports has the same
 * shape: the app keeps working, just not the way the operator believes —
 * ACCOUNTS_ENABLED set without a real SESSION_SECRET, a missing BREVO_API_KEY
 * sending verification mail to the in-memory outbox (lib/mail.js degrades by
 * design), S3_BUCKET unset so uploads land on an ephemeral container
 * filesystem, ADMIN_PASSWORD equal to AUTH_PASSWORD (a privilege escalation —
 * see lib/admin.js's header). None of these announce themselves.
 *
 * TWO RULES, both load-bearing:
 *
 * 1. NEVER return a secret — not in full, not truncated, not hashed-and-shown.
 *    Every field here is a derived boolean, an enum, a number, or a public host
 *    name. The panel is password-gated, not secret-cleared, and a screenshot of
 *    it must be harmless. Where two secrets are compared (see `distinct`
 *    below), only the verdict escapes.
 * 2. Read every value PER CALL, never at module load, so the answer describes
 *    the process as it is now and a test can drive it deterministically — the
 *    same reason lib/app.js reads its rate-limit ceilings and lib/admin.js its
 *    config per call (.claude/rules/security-middleware.md).
 *
 * Read-only by construction: there is no writer here and the panel offers no
 * editing. Env vars stay a deliberate Railway action.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const accounts = require('./accounts');
const admin = require('./admin');
const quota = require('./quota');
const storage = require('./storage');
const repo = require('./repo');
const canonical = require('./canonical');

const ROOT = path.join(__dirname, '..');

const isSet = (name) => !!(process.env[name] && process.env[name].length);

// Whether two secrets differ, WITHOUT revealing either — only the verdict
// escapes. Deliberately the same shape as lib/admin.js's and lib/auth.js's
// safeEqual (length check, then timingSafeEqual on the raw bytes), so there is
// one "compare two secrets" idiom in the codebase rather than a second variant.
//
// Note what this is NOT: no digest is stored, transmitted or returned, so this
// is an equality test, not password hashing — hashing the operands first (to
// avoid the length short-circuit) would look like a weak password hash to a
// reader and to a scanner, for a side-channel that does not exist here. The only
// thing an unequal-length short-circuit could reveal is whether two secrets share
// a length, to a caller who is already an authenticated operator and who receives
// the equality verdict itself in the response.
//
// An unset `b` counts as distinct: there is nothing to collide with.
function distinct(a, b) {
  if (!a) return false;
  if (!b) return true;
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return true;
  return !crypto.timingSafeEqual(ab, bb);
}

// Whether the content-hashed production build (dist/, issue #141) is what's
// being served. Exported and used by lib/app.js's assetDir() so the panel can
// never disagree with reality — reporting "built" while public/ is served would
// be worse than not reporting it at all. Serving public/ in production is a
// legitimate fallback (a production run with no dist/ doesn't 404), but you want
// to know which one you got. See .claude/rules/frontend-build-cache-busting.md.
function assetsBuilt() {
  return process.env.NODE_ENV === 'production'
    && fs.existsSync(path.join(ROOT, 'dist', 'index.html'));
}

// The deployed revision, so "did my change actually ship?" is answerable from
// the panel. Railway injects RAILWAY_GIT_COMMIT_SHA; the others are fallbacks
// for other hosts. Shortened to the usual 7 chars — a commit sha is public
// information, not a secret.
function commit() {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.SOURCE_COMMIT;
  return sha ? String(sha).slice(0, 7) : null;
}

function version() {
  try {
    return require('../package.json').version || null;
  } catch {
    return null;
  }
}

async function instanceStatus() {
  const authPassword = process.env.AUTH_PASSWORD || '';

  return {
    app: {
      version: version(),
      commit: commit(),
      nodeEnv: process.env.NODE_ENV || null,
      uptimeSeconds: Math.floor(process.uptime()),
    },

    // The gate that opens public registration (#219). `enabled` is
    // accountsEnabled() itself, which already requires BOTH the flag and a
    // non-empty SESSION_SECRET — so the flag being on while `enabled` is false
    // is exactly the silent misconfiguration this card exists to surface.
    accounts: {
      enabled: accounts.accountsEnabled(),
      flagSet: process.env.ACCOUNTS_ENABLED === 'true',
      sessionSecretSet: isSet('SESSION_SECRET'),
      // SESSION_SECRET must NOT be the shared app password: it signs access
      // tokens, and the shared password is known to the whole group, so reusing
      // it would let any member forge any user's token
      // (.claude/rules/user-accounts.md).
      sessionSecretDistinct: distinct(process.env.SESSION_SECRET, authPassword),
    },

    // ADMIN_PASSWORD must differ from AUTH_PASSWORD for two reasons spelled out
    // in lib/admin.js: these powers are cross-tenant, and a shared value would
    // make an ordinary app session token verify as an admin token.
    admin: {
      enabled: admin.adminEnabled(),
      secretDistinct: distinct(process.env.ADMIN_PASSWORD, authPassword),
    },

    // Without BREVO_API_KEY lib/mail.js silently routes to the in-memory outbox
    // — verification and reset mails are simply never delivered.
    mail: {
      configured: isSet('BREVO_API_KEY'),
      fromSet: isSet('MAIL_FROM'),
      baseUrlSet: isSet('APP_BASE_URL'),
    },

    // 'disk' means covers live on the container filesystem and vanish on the
    // next deploy; 'json' means round data does too.
    storage: {
      images: storage.backend,
      data: process.env.DATABASE_URL ? 'postgres' : 'json',
    },

    // The ceilings are inert unless accounts are on
    // (.claude/rules/per-tenant-quotas.md), so `enforced` is the field that
    // matters — the numbers alone would read as protection that isn't there.
    quotas: {
      enforced: quota.enforced(),
      roundsPerTenant: quota.roundsPerTenant(),
      gamesPerRound: quota.gamesPerRound(),
      tagsPerRound: quota.tagsPerRound(),
    },

    // Public domain names, not secrets. Mirrors how lib/canonical.js resolves
    // them per createApp().
    hosts: {
      canonical: canonical.canonicalHost(),
      redirects: canonical.redirectHosts(),
    },

    assets: { built: assetsBuilt() },

    // Makes a deploy that didn't migrate visible.
    migrations: await repo.migrationStatus(),
  };
}

module.exports = { instanceStatus, assetsBuilt };
