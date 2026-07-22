'use strict';

/*
 * App-wide unique usernames (issue #320).
 *
 * Every account picks a public handle at registration, so a user is findable
 * without their e-mail address (invitations, #207) and nameable in an abuse
 * report. Uniqueness is CASE-INSENSITIVE — `Anna` and `anna` are the same
 * account — while the casing the user typed is preserved for display, so the
 * index is on lower(...) rather than the raw value.
 *
 * No backfill: accounts mode is off in production, so no real account predates
 * the field (which is exactly why #320 ships before go-live, #219). Rows
 * without a username are still legal here — lower(NULL) is NULL and NULLs never
 * collide in a unique index — which keeps any dev-only row from blocking the
 * migration. The repo checks the handle explicitly before inserting; this index
 * is the race backstop for two simultaneous registrations.
 */

exports.up = async (knex) => {
  await knex.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users((lower(data->>'username')))",
  );
};

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS users_username_idx');
};
