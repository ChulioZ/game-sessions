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
// Internal marker — never a real tenant id, so it can't collide with one.
const SUSPENDED = Symbol('suspended');

// The tenant a request acts as (see the resolution rules above). Returns the
// SUSPENDED symbol when the authenticated account has been disabled by an
// operator, so withTenant can refuse instead of scoping a repo to it.
async function resolveTenantId(req) {
  if (!accounts.accountsEnabled()) return DEFAULT_TENANT;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const uid = token ? accounts.verifyAccessToken(token) : null;
  if (!uid) return DEFAULT_TENANT;
  const user = await repo.getUserById(uid);
  if (user && user.disabled) return SUSPENDED;
  return (user && user.tenantId) || DEFAULT_TENANT;
}

async function withTenant(req, res, next) {
  const tid = await resolveTenantId(req);
  if (tid === SUSPENDED) return res.status(403).json({ error: 'account_disabled' });
  req.tenantId = tid;
  req.repo = repo.forTenant(req.tenantId);
  next();
}

module.exports = { DEFAULT_TENANT, withTenant };
