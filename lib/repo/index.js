'use strict';

/*
 * Data-access layer entry point — picks the backend once, at require time.
 *
 * Routes do `require('../lib/repo')` and get whichever backend is configured:
 *   - DATABASE_URL set  -> ./postgres.js (managed PostgreSQL)
 *   - otherwise         -> ./json.js     (the default: data/data.json)
 *
 * The default stays the zero-dependency JSON store, so local dev and the test
 * suite run without a database (issue #127). Both backends implement the same
 * async contract (see json.js for the documented shape); a caller must
 * `await repo.init()` once before serving so the Postgres backend can ensure its
 * schema (json.init() is a no-op). server.js does this before listening.
 *
 * Tenancy (issue #136): every round-scoped method takes the caller's tenant id
 * as its FIRST argument and never returns another tenant's data. Routes don't
 * pass it themselves — the tenant middleware (lib/tenant.js) resolves the
 * caller's tenant once per request and sets `req.repo = repo.forTenant(tid)`,
 * so the scope is enforced in one place, not per-handler. The user methods
 * (createUser/getUserById/...) stay global: users are the identity layer that
 * tenants hang off (each user carries a `tenantId` field), queried by email at
 * login before any tenant is known.
 *
 * The moderation methods (findImageOwner/takedownImage/logModeration/
 * listModeration/listUsers — issue #268) are global too, and are the ONE place
 * that deliberately sees across tenants: an abuse notice names an image, not a
 * tenant, so the operator lookup cannot be tenant-scoped. They are absent from
 * TENANT_METHODS on purpose, so they are reachable only on the module-level repo
 * from the admin-gated routes (routes/admin.js) — never via req.repo, which is
 * all an ordinary request handler holds. See
 * .claude/rules/admin-moderation-surface.md.
 */

const backend = process.env.DATABASE_URL ? require('./postgres') : require('./json');

// Every method that reads or writes round data — i.e. everything that must be
// tenant-scoped. Kept as an explicit list so a new repo method can't silently
// bypass the facade: forgetting to add it here makes req.repo.<method> throw.
const TENANT_METHODS = [
  'listRounds',
  'getRound',
  'createRound',
  'deleteRound',
  'updateMember',
  'createGame',
  'updateGame',
  'retireGame',
  'deleteGame',
  'isImageReferenced',
  'createSession',
  'saveSessionResults',
  'setSessionChoice',
  'finishSession',
  'cancelSession',
  'removeSessionGame',
  'deleteSession',
  'listActivities',
  'deleteActivity',
  'setBackground',
  'addTag',
  'deleteTag',
];

// A view of the repo with the tenant baked into every round-scoped method, so a
// route holding it CANNOT reach another tenant's rounds.
function forTenant(tenantId) {
  const scoped = {};
  for (const name of TENANT_METHODS) scoped[name] = backend[name].bind(null, tenantId);
  return scoped;
}

module.exports = { ...backend, forTenant };
