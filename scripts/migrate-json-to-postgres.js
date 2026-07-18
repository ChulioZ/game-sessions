'use strict';

/*
 * One-off migration: the JSON file store (data/data.json) -> PostgreSQL.
 * Issue #127, the final step of the persistence migration.
 *
 * This is a *one-time* tool, run manually — not runtime code (CLAUDE.md: no
 * migration code in the backend). It reads the existing data.json and bulk-inserts
 * every round into Postgres via repo.importRounds, PRESERVING ids so all
 * cross-references stay valid, under the default tenant (the tenant_id column
 * default). Cover images stay as files under DATA_DIR/uploads for now — only the
 * path is stored, exactly as before; moving the files to object storage is #128.
 *
 * Run it with the server STOPPED (see .claude/rules/data-json-external-edits.md)
 * and against an EMPTY target database (it refuses a non-empty one):
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/db \
 *     [DATA_DIR=./data] [DATABASE_SSL=true] \
 *     node scripts/migrate-json-to-postgres.js
 *
 * It is idempotent-by-refusal, not by merge: to re-run, truncate the target first.
 */

const fs = require('fs');
const path = require('path');

// Fold the pre-#115 single `recommendations` object into the run-history array,
// as the app does on first write (see history() in routes/recommendations.js), so
// nothing is lost by the migration. Current production data has already migrated
// this on any write, but stay defensive.
function normalize(round) {
  if (!Array.isArray(round.recommendationRuns) && round.recommendations && Array.isArray(round.recommendations.items)) {
    round.recommendationRuns = [{ id: 'legacy', ...round.recommendations }];
  }
  delete round.recommendations;
  return round;
}

// Read + normalize the dataset from a data.json file (defensive like the store:
// missing/empty arrays become []). `users` exists since #135.
function readData(dataFile) {
  const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  return {
    rounds: (Array.isArray(parsed.rounds) ? parsed.rounds : []).map(normalize),
    users: Array.isArray(parsed.users) ? parsed.users : [],
  };
}

function counts({ rounds, users }) {
  const sum = (key) => rounds.reduce((n, r) => n + (Array.isArray(r[key]) ? r[key].length : 0), 0);
  return {
    rounds: rounds.length,
    members: sum('members'),
    games: sum('games'),
    sessions: sum('sessions'),
    activities: sum('activities'),
    users: users.length,
  };
}

// Import `rounds` into the Postgres backend `repo`. Refuses a non-empty target so
// a re-run can't silently double-import. Ensures the schema first. Caller owns the
// repo lifecycle (init side-effects aside, it does not close the pool).
async function migrate(repo, { rounds, users }) {
  await repo.init();
  const existing = await repo.listRounds();
  if (existing.length > 0) {
    throw new Error(
      `target database already has ${existing.length} round(s); refusing to import into a non-empty database ` +
      '(truncate it first if you really mean to re-migrate)'
    );
  }
  await repo.importRounds(rounds);
  await repo.importUsers(users);
  return counts({ rounds, users });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL to the target PostgreSQL database, e.g.\n' +
      '  DATABASE_URL=postgres://user:pass@host:5432/db node scripts/migrate-json-to-postgres.js');
    process.exit(1);
  }
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
  const dataFile = path.join(dataDir, 'data.json');

  let dataset;
  try {
    dataset = readData(dataFile);
  } catch (err) {
    console.error(`Cannot read ${dataFile}: ${err.message}`);
    process.exit(1);
  }

  // DATABASE_URL is set, so this resolves to the Postgres backend.
  const repo = require('../lib/repo');
  try {
    const c = await migrate(repo, dataset);
    console.log(`Migrated from ${dataFile} to PostgreSQL:`);
    console.log(`  ${c.rounds} rounds, ${c.members} members, ${c.games} games, ` +
      `${c.sessions} sessions, ${c.activities} activities, ${c.users} users.`);
    console.log('Cover images remain under DATA_DIR/uploads (object storage is #128).');
  } catch (err) {
    console.error('Migration failed:', err.message);
    await repo.end();
    process.exit(1);
  }
  await repo.end();
}

module.exports = { normalize, readData, counts, migrate };

if (require.main === module) main();
