'use strict';

/*
 * Per-user in-app inbox (issue #207).
 *
 * The generic notification surface that account-scoped features deliver
 * actionable items through — round invitations (#207) and friend requests
 * (#325) are the first consumers, added in later slices. This migration ships
 * only the store.
 *
 * Deliberately NOT tenant-scoped and NOT under RLS, exactly like `users`: an
 * item is keyed by the RECIPIENT's account id (`user_id`), which is the identity
 * layer, not a tenant. It IS reached from user-facing routes (routes/account.js),
 * so the app layer scopes every query to the authenticated caller's own id — the
 * table is a plain global store. Row shape mirrors the other global stores: an
 * `id`, a `data jsonb` blob, and a `seq bigserial` backing the newest-first read;
 * `user_id` is promoted to its own indexed column so one user's items read in a
 * single indexed scan.
 */

exports.up = async (knex) => {
  await knex.raw(`
CREATE TABLE IF NOT EXISTS inbox (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  data jsonb NOT NULL,
  seq bigserial
);
CREATE INDEX IF NOT EXISTS inbox_user_idx ON inbox(user_id, seq DESC);
`);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS inbox');
};
