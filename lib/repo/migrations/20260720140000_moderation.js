'use strict';

/*
 * Operator moderation support (issue #268).
 *
 * Two things:
 *
 * 1. A global `moderation_log` table — the record of operator actions (what was
 *    taken down / suspended, when, and why) that DSA Art. 17 statements of
 *    reasons need. Deliberately NOT tenant-scoped and NOT under RLS, exactly
 *    like `users`: it is operator data ABOUT tenants, so scoping it to one would
 *    defeat its purpose.
 *
 * 2. A READ-ONLY admin escape in the round tables' RLS policies. An abuse notice
 *    names a cover image, not a tenant, so resolving `/uploads/<key>` -> owning
 *    game/round/tenant is inherently cross-tenant, and under FORCE RLS an
 *    unscoped read sees zero rows (fail-closed). The policies therefore also
 *    admit a transaction that has explicitly set `app.admin = 'on'`
 *    (lib/repo/postgres.js `atx()`), transaction-local via set_config(..., true)
 *    so it dies at COMMIT and never leaks to the next pooled checkout — the same
 *    guarantee `app.tenant_id` already relies on.
 *
 *    The escape is added to USING only, NOT to WITH CHECK. USING governs which
 *    existing rows a statement may SEE; WITH CHECK governs rows it may WRITE. So
 *    the admin flag can widen a lookup and can never widen a write — an operator
 *    read discovers the owning tenant, and the actual takedown then runs through
 *    the ordinary tenant-scoped `tx(tenant, ...)` path, still fully isolated.
 *    Keep it that way; see .claude/rules/admin-moderation-surface.md.
 */

const RLS_TABLES = ['rounds', 'members', 'games', 'sessions', 'activities'];

// USING gains the admin escape; WITH CHECK stays strictly tenant-matched.
const RLS_WITH_ADMIN_READ = RLS_TABLES.map((t) => `
DROP POLICY IF EXISTS ${t}_tenant_isolation ON ${t};
CREATE POLICY ${t}_tenant_isolation ON ${t}
  USING (tenant_id = current_setting('app.tenant_id', true)
         OR current_setting('app.admin', true) = 'on')
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
`).join('\n');

// The pre-#268 policies (tenant match on both clauses) — restored by down().
const RLS_ORIGINAL = RLS_TABLES.map((t) => `
DROP POLICY IF EXISTS ${t}_tenant_isolation ON ${t};
CREATE POLICY ${t}_tenant_isolation ON ${t}
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
`).join('\n');

exports.up = async (knex) => {
  await knex.raw(`
CREATE TABLE IF NOT EXISTS moderation_log (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  seq bigserial
);
CREATE INDEX IF NOT EXISTS moderation_log_seq_idx ON moderation_log(seq DESC);
`);
  await knex.raw(RLS_WITH_ADMIN_READ);
};

exports.down = async (knex) => {
  await knex.raw(RLS_ORIGINAL);
  await knex.raw('DROP TABLE IF EXISTS moderation_log');
};
