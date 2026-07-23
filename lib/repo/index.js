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
 * (createUser/getUserById/getUserByUsername/...) stay global: users are the
 * identity layer that tenants hang off (each user carries a `tenantId` field),
 * queried by email at login — and by username (#320) from the admin lookup —
 * before any tenant is known.
 *
 * The operator methods (findImageOwner/takedownImage/logModeration/
 * listModeration/listUsers — issue #268; exportTenant/eraseAccount — issue #273;
 * findRoundOwner/tenantSummary/roundContent/redactText/moderationActions —
 * issue #275) are global too, and are the ONE place that deliberately reaches
 * past the tenant facade: an abuse notice names an image, a round link or an
 * e-mail address, and an erasure request names an account — none of which is a
 * tenant the caller already holds. They are absent from TENANT_METHODS on
 * purpose, so they are reachable only on the module-level repo from the
 * admin-gated routes (routes/admin.js) — never via req.repo, which is all an
 * ordinary request handler holds. See
 * .claude/rules/admin-moderation-surface.md.
 *
 * User feedback (createFeedback/listFeedback — issue #260) is global for the
 * same reason: it is data ABOUT the app, addressed to the operator, who reads it
 * across every tenant. Also absent from TENANT_METHODS — since #321 the write is
 * reached on the module-level repo from routes/contact.js (the 'feedback'
 * category of the public contact form) and the read only from the admin-gated
 * routes/admin.js.
 *
 * Contact notices (createContactNotice/listContactNotices/… — issue #272) follow
 * the feedback pattern exactly: a stored abuse notice / contact submission is
 * addressed to the operator and usually comes from someone who is not a user at
 * all, so the store is global and absent from TENANT_METHODS.
 *
 * The per-user inbox (addInboxItem/listInbox/markInboxRead/dismissInboxItem —
 * issue #207) is global for a different reason: it is keyed by the RECIPIENT's
 * account id (the identity layer), not a tenant, so it is absent from
 * TENANT_METHODS too. It is the one global store deliberately reached from
 * user-facing routes (routes/account.js) rather than only the admin ones, so
 * every method takes the caller's userId and scopes to it — the enforcement is
 * in the handler, not the facade.
 *
 * Round grants (createGrant/listGrantsForUser/listGrantsForRound/deleteGrant —
 * issue #207) are global too, and for the sharpest version of the reason: a
 * grant POINTS a grantee at a round in ANOTHER tenant, so it cannot be scoped to
 * either party's tenant. Absent from TENANT_METHODS. The resolver that reads a
 * caller's grants and runs their request under the round's OWNER tenant (so RLS
 * stays un-widened) is a later slice of #207; this ships only the store. Note
 * `createMember` — added alongside — IS tenant-scoped (a member belongs to a
 * round in a tenant) and so is listed in TENANT_METHODS above.
 */

const backend = process.env.DATABASE_URL ? require('./postgres') : require('./json');

// Every method that reads or writes round data — i.e. everything that must be
// tenant-scoped. Kept as an explicit list so a new repo method can't silently
// bypass the facade: forgetting to add it here makes req.repo.<method> throw.
const TENANT_METHODS = [
  'listRounds',
  'listRoundSummaries',
  'getRound',
  'getRoundMeta',
  'getSession',
  'getGame',
  'createRound',
  'deleteRound',
  'createMember',
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
