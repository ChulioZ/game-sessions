'use strict';

/*
 * Tenant resolution middleware (issue #136) — THE one place a request's tenant
 * is decided. It runs on every /api data route (mounted in lib/app.js, after
 * the shared-password gate) and sets:
 *   req.tenantId — the caller's tenant
 *   req.repo     — the data-access layer scoped to it (repo.forTenant)
 * Routes read/write ONLY through req.repo, so no handler can forget the scope
 * (see .claude/rules/data-access-layer.md).
 *
 * Resolution:
 *  - Accounts enabled (#135) AND a valid Bearer access token -> the user's
 *    tenantId (minted at registration; 'default' for users predating tenancy).
 *  - Otherwise -> 'default': the single pre-tenancy group that the shared
 *    password gate (lib/auth.js) protects. This keeps today's production
 *    instance byte-for-byte unchanged — accounts are off there, so every
 *    caller is the default tenant, exactly as before.
 * An invalid/expired Bearer token also falls back to 'default' rather than
 * 401ing: the account layer isn't this instance's gate yet (that switch is
 * #138's onboarding work), and 'default' is itself still behind the gate.
 *
 * ERASED accounts (#273) are refused here rather than falling back. Access tokens
 * are stateless JWTs with a 15-minute TTL, so one minted before an erasure stays
 * signature-valid after the user row is gone — and `|| DEFAULT_TENANT` below
 * would then have handed that token the 'default' tenant, i.e. the legacy
 * production group's data. So a token whose uid no longer resolves to a user is
 * a 401, not a downgrade. The fallback still applies to a MISSING or INVALID
 * token (the legacy shared-password mode, where nobody authenticates per-user);
 * the distinction is "this token names an account that does not exist" versus
 * "this request names no account at all".
 *
 * Suspension (#268): this is also where an operator-disabled account is stopped.
 * It's the right place because the user row is ALREADY loaded here on every /api
 * request in accounts mode, so the check costs no extra query — and unlike
 * refusing only at login it takes effect immediately, on reads and writes alike,
 * rather than after the 15-minute access-token TTL. The data is left completely
 * untouched, so evidence survives a later law-enforcement request.
 */

const repo = require('./repo');
const accounts = require('./accounts');

const DEFAULT_TENANT = 'default';
// Internal markers — never real tenant ids, so they can't collide with one.
const SUSPENDED = Symbol('suspended');
const ERASED = Symbol('erased');

// The tenant a request acts as (see the resolution rules above). Returns the
// SUSPENDED symbol when the authenticated account has been disabled by an
// operator, or ERASED when its user row is gone, so withTenant can refuse
// instead of scoping a repo to it.
async function resolveTenantId(req) {
  if (!accounts.accountsEnabled()) return DEFAULT_TENANT;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const uid = token ? accounts.verifyAccessToken(token) : null;
  if (!uid) return DEFAULT_TENANT;
  const user = await repo.getUserById(uid);
  if (!user) return ERASED;
  if (user.disabled) return SUSPENDED;
  return user.tenantId || DEFAULT_TENANT;
}

async function withTenant(req, res, next) {
  const tid = await resolveTenantId(req);
  if (tid === SUSPENDED) return res.status(403).json({ error: 'account_disabled' });
  // 'auth_required' (not a distinct code) on purpose: the SPA's api() already
  // treats it as session-lost — one silent refresh attempt, which fails because
  // the refresh tokens died with the row, then a bounce to login. Exactly the
  // right behaviour for an account that no longer exists, with no client change.
  if (tid === ERASED) return res.status(401).json({ error: 'auth_required' });
  req.tenantId = tid;
  req.repo = repo.forTenant(req.tenantId);
  next();
}

module.exports = { DEFAULT_TENANT, withTenant };
