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
 * The operator methods (findImageOwner/takedownImage/logModeration/
 * listModeration/listUsers — issue #268; exportTenant/eraseAccount — issue #273)
 * are global too, and are the ONE place that deliberately reaches past the
 * tenant facade: an abuse notice names an image and an erasure request names an
 * account, neither of which is a tenant the caller already holds. They are
 * absent from TENANT_METHODS on purpose, so they are reachable only on the
 * module-level repo from the admin-gated routes (routes/admin.js) — never via
 * req.repo, which is all an ordinary request handler holds. See
 * .claude/rules/admin-moderation-surface.md.
 *
 * User feedback (createFeedback/listFeedback — issue #260) is global for the
 * same reason: it is data ABOUT the app, addressed to the operator, who reads it
 * across every tenant. The submitter's tenant is recorded as metadata on the
 * entry, not as an isolation boundary. Also absent from TENANT_METHODS — the
 * write is reached on the module-level repo from routes/feedback.js and the read
 * only from the admin-gated routes/admin.js.
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
  'completeGame',
  'deleteGame',
  'moveGames',
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
  'setTagIcon',
  'deleteTag',
  'setProviders',
];

// A view of the repo with the tenant baked into every round-scoped method, so a
// route holding it CANNOT reach another tenant's rounds.
function forTenant(tenantId) {
  const scoped = {};
  for (const name of TENANT_METHODS) scoped[name] = backend[name].bind(null, tenantId);
  return scoped;
}

module.exports = { ...backend, forTenant };
