'use strict';

/*
 * Per-round access grants (issue #207) — the data model for round sharing.
 *
 * A grant records that account `user_id` may act on round `round_id`, owned by
 * `owner_tenant_id` (kept in the jsonb blob), holding a member seat, with a role.
 *
 * Deliberately NOT tenant-scoped and NOT under RLS, exactly like `users`: a grant
 * is inherently CROSS-tenant (it points a grantee at a round in someone else's
 * tenant), so it cannot live under the per-tenant RLS facade. The resolver that
 * turns a grant into access — running a grantee's request under the round's OWNER
 * tenant, so RLS still needs no widening — is a later slice of #207; this ships
 * only the store.
 *
 * Row shape mirrors the other global stores: `id` + `data jsonb` + `seq
 * bigserial`, with `round_id` and `user_id` promoted to columns for the unique
 * pair and the two hot reads (a user's grants, a round's grants).
 */

exports.up = async (knex) => {
  await knex.raw(`
CREATE TABLE IF NOT EXISTS round_grants (
  id text PRIMARY KEY,
  round_id text NOT NULL,
  user_id text NOT NULL,
  data jsonb NOT NULL,
  seq bigserial
);
CREATE UNIQUE INDEX IF NOT EXISTS round_grants_pair_idx ON round_grants(round_id, user_id);
CREATE INDEX IF NOT EXISTS round_grants_user_idx ON round_grants(user_id, seq);
`);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS round_grants');
};
