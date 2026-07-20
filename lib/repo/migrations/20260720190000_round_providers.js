'use strict';

/*
 * Per-round lookup-provider configuration (issue #294): a `providers jsonb`
 * column on rounds holding the enabled provider ids, e.g. ["bgg", "steam"].
 *
 * Stays NULL until a round is configured, and NULL means "all providers
 * enabled" — the pre-#294 behaviour. So assemble() emits the key only when it
 * has ever been written (absent-key parity with the JSON backend, see
 * .claude/rules/postgres-backend.md), and an existing round needs no migration
 * of its data. An empty array is a distinct, legitimate value: "query nothing".
 */

exports.up = (knex) => knex.schema.alterTable('rounds', (t) => t.jsonb('providers'));

exports.down = (knex) => knex.schema.alterTable('rounds', (t) => t.dropColumn('providers'));
