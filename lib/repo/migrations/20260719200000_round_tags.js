'use strict';

/*
 * Round-level custom tags (issue #238): a `tags jsonb` column on rounds holding
 * the [{ id, name }] list. Stays NULL until the first tag is created, so
 * assemble() emits the key only when it has ever been written — absent-key
 * parity with the JSON backend (.claude/rules/postgres-backend.md). Games
 * reference tags via a `tagIds` array inside their `data` jsonb, so no schema
 * change is needed there.
 */

exports.up = (knex) => knex.schema.alterTable('rounds', (t) => t.jsonb('tags'));

exports.down = (knex) => knex.schema.alterTable('rounds', (t) => t.dropColumn('tags'));
