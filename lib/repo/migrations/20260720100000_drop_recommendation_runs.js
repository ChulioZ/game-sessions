'use strict';

/*
 * Drop rounds.recommendation_runs (issue #264): the buy-next recommendations
 * feature — the app's only AI surface — was removed entirely, so the column has
 * no reader or writer left.
 *
 * This is the one destructive step of that removal: it discards the stored
 * suggestion-run history, which is intended (a nice-to-have log, never source
 * data). Ship it in the same deploy as the code — init() runs migrations before
 * listen(), so a lagging app instance never reads a column that is already gone
 * (see .claude/rules/postgres-backend.md).
 *
 * down() re-adds the column but cannot restore the dropped rows; it exists so a
 * rollback lands on a schema the pre-#264 code can run against.
 */

exports.up = async (knex) => {
  await knex.raw('ALTER TABLE rounds DROP COLUMN IF EXISTS recommendation_runs');
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE rounds ADD COLUMN IF NOT EXISTS recommendation_runs jsonb');
};
