'use strict';

/*
 * The one-off data.json -> PostgreSQL migration (scripts/migrate-json-to-postgres)
 * against a real Postgres backend (issue #127). Runs only when DATABASE_URL is set
 * (CI's Postgres service container, or a local one) — otherwise skipped, so plain
 * `npm test` stays database-free. Truncates before each case for isolation.
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATABASE_URL) {
  test('migration script (skipped: set DATABASE_URL to run)', { skip: true }, () => {});
} else {
  const { Client } = require('pg');
  const repo = require('../lib/repo'); // DATABASE_URL is set -> Postgres backend
  const { migrate, readData } = require('../scripts/migrate-json-to-postgres');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-migrate-'));
  const dataFile = path.join(dataDir, 'data.json');

  // A small dataset covering the field kinds + a pre-#115 legacy `recommendations`
  // object (to prove the fold) and a round with none (to prove the key stays absent).
  const sample = {
    rounds: [
      {
        id: 'r1', name: 'One',
        members: [{ id: 'm1', name: 'A', color: '#1d9e75' }],
        games: [{
          id: 'g1', title: 'G', platform: 'analog', type: 'analog', duration: 'medium',
          minPlayers: 1, maxPlayers: 4, image: '/uploads/g1.jpg', retired: false, retiredAt: null,
        }],
        sessions: [{
          id: 's1', createdAt: 't', gameIds: ['g1'], votes: { m1: { g1: { rating: 5 } } },
          chosenGameId: 'g1', chosenAt: 't', finished: true, finishedAt: 't', winnerIds: ['m1'],
          cancelled: false, cancelledAt: null, done: true,
        }],
        activities: [{ id: 'a1', type: 'game_added', at: 't', gameId: 'g1', title: 'G' }],
        background: null,
        recommendations: { generatedAt: 't', items: [{ title: 'Rec' }] }, // legacy
      },
      {
        id: 'r2', name: 'Two',
        members: [{ id: 'm2', name: 'B' }], games: [], sessions: [], activities: [],
        background: { type: 'theme', page: 'p', accent: 'a' },
      },
    ],
    users: [{
      id: 'u1', email: 'a@example.com', createdAt: 't', emailVerified: true,
      identities: [{ type: 'password', hash: 'x' }], verification: null, reset: null, refreshTokens: [],
    }],
  };

  before(() => {
    fs.writeFileSync(dataFile, JSON.stringify(sample));
  });

  beforeEach(async () => {
    await repo.init();
    const c = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    await c.connect();
    await c.query('TRUNCATE rounds, members, games, sessions, activities, users CASCADE');
    await c.end();
  });

  after(async () => {
    await repo.end();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('migrates data.json into Postgres, preserving ids and folding legacy recommendations', async () => {
    const dataset = readData(dataFile);
    const c = await migrate(repo, dataset);
    assert.deepEqual(c, { rounds: 2, members: 2, games: 1, sessions: 1, activities: 1, users: 1 });

    const r1 = await repo.getRound('r1');
    assert.equal(r1.name, 'One');
    assert.equal(r1.members[0].id, 'm1');
    assert.equal(r1.games[0].id, 'g1');
    assert.equal(r1.sessions[0].id, 's1');
    assert.equal(r1.sessions[0].votes.m1.g1.rating, 5); // nested reference intact
    assert.equal((await repo.listActivities('r1'))[0].id, 'a1');
    // Legacy `recommendations` folded into the run history; the raw key is gone.
    assert.equal('recommendations' in r1, false);
    assert.equal(r1.recommendationRuns[0].id, 'legacy');
    assert.deepEqual(r1.recommendationRuns[0].items, [{ title: 'Rec' }]);

    const r2 = await repo.getRound('r2');
    assert.deepEqual(r2.background, { type: 'theme', page: 'p', accent: 'a' });
    assert.equal('recommendationRuns' in r2, false); // no recs -> key stays absent

    // Users (#135) ride along, id preserved.
    const u1 = await repo.getUserById('u1');
    assert.equal(u1.email, 'a@example.com');
    assert.deepEqual(u1.identities, [{ type: 'password', hash: 'x' }]);
  });

  test('refuses to import into a non-empty target', async () => {
    await repo.importRounds([
      { id: 'existing', name: 'X', members: [], games: [], sessions: [], activities: [], background: null },
    ]);
    await assert.rejects(() => migrate(repo, readData(dataFile)), /non-empty database/);
  });
}
