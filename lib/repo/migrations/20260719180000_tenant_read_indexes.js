'use strict';

/*
 * Indexes for the tenant-wide single-statement reads (issue #203): listRounds
 * now fetches ALL of a tenant's members/games/sessions in one statement filtered
 * by tenant_id alone (no round_id), which the baseline's (round_id, seq) indexes
 * don't serve — at multi-tenant scale that would be a sequential scan over every
 * tenant's rows on each home-screen load. (tenant_id, seq) matches that filter
 * and its ORDER BY seq exactly. rounds already has rounds_tenant_idx from the
 * baseline; activities stay on (round_id, seq) — they are only read per round.
 */

exports.up = async (knex) => {
  await knex.raw(`
CREATE INDEX IF NOT EXISTS members_tenant_idx  ON members(tenant_id, seq);
CREATE INDEX IF NOT EXISTS games_tenant_idx    ON games(tenant_id, seq);
CREATE INDEX IF NOT EXISTS sessions_tenant_idx ON sessions(tenant_id, seq);
`);
};

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS members_tenant_idx, games_tenant_idx, sessions_tenant_idx');
};
