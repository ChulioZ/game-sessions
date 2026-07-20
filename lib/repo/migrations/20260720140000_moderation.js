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
 * 2. A READ-ONLY admin escape in the round tables' RLS. An abuse notice names a
 *    cover image, not a tenant, so resolving `/uploads/<key>` -> the owning
 *    game/round/tenant is inherently cross-tenant, and under FORCE RLS an
 *    unscoped read sees zero rows (fail-closed). The escape admits a transaction
 *    that has explicitly set `app.admin = 'on'` (lib/repo/postgres.js `atx()`),
 *    transaction-local via set_config(..., true) so it dies at COMMIT and never
 *    leaks to the next pooled checkout — the same guarantee `app.tenant_id`
 *    already relies on.
 *
 *    HOW it is made read-only matters, and the obvious way is WRONG. Adding
 *    `OR app.admin` to the existing FOR ALL policy's USING clause while leaving
 *    WITH CHECK tenant-matched looks like it permits reads only — but
 *    **DELETE is governed by USING alone; there is no WITH CHECK for DELETE.**
 *    That shape silently lets a DELETE inside an admin transaction remove ANY
 *    tenant's rows. Verified empirically before this was rewritten: under that
 *    policy a cross-tenant `DELETE FROM games` reported rowCount 1 with the flag
 *    set, 0 without it.
 *
 *    So the tenant policy is left completely UNCHANGED (still FOR ALL, tenant-
 *    matched on both clauses) and the escape is a SEPARATE, additive
 *    `FOR SELECT` policy. Postgres OR-combines permissive policies per command,
 *    so a SELECT passes on "tenant matches OR admin is on", while INSERT/UPDATE/
 *    DELETE only ever consult the tenant policy. The read-only property is then
 *    STRUCTURAL — a DELETE or UPDATE later written inside `atx()` is still
 *    refused by the database — rather than a convention someone has to remember.
 *    Keep that split; see .claude/rules/admin-moderation-surface.md.
 */

const RLS_TABLES = ['rounds', 'members', 'games', 'sessions', 'activities'];

// Additive and SELECT-only. The existing <t>_tenant_isolation policy is NOT
// touched, so write isolation is exactly what it was before this migration.
const ADMIN_READ_POLICY = RLS_TABLES.map((t) => `
DROP POLICY IF EXISTS ${t}_admin_read ON ${t};
CREATE POLICY ${t}_admin_read ON ${t}
  FOR SELECT
  USING (current_setting('app.admin', true) = 'on');
`).join('\n');

const DROP_ADMIN_READ_POLICY = RLS_TABLES
  .map((t) => `DROP POLICY IF EXISTS ${t}_admin_read ON ${t};`)
  .join('\n');

exports.up = async (knex) => {
  await knex.raw(`
CREATE TABLE IF NOT EXISTS moderation_log (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  seq bigserial
);
CREATE INDEX IF NOT EXISTS moderation_log_seq_idx ON moderation_log(seq DESC);
`);
  await knex.raw(ADMIN_READ_POLICY);
};

exports.down = async (knex) => {
  await knex.raw(DROP_ADMIN_READ_POLICY);
  await knex.raw('DROP TABLE IF EXISTS moderation_log');
};
