'use strict';

// Route tests for the one-time legacy platform/duration → tags migration (#242).
// The create/update routes no longer write platform/duration, so a "legacy" game
// is seeded directly on the JSON store, then migrated through the API.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, createRound, store } = require('./helpers');

async function addGame(rid, title) {
  return (
    await request(app)
      .post(`/api/rounds/${rid}/games`)
      .field('title', title)
      .field('minPlayers', '1')
      .field('maxPlayers', '4')
  ).body;
}

// Inject a legacy field onto a stored game (the API no longer writes these).
function setLegacy(rid, gid, patch) {
  const g = store.findRound(rid).games.find((x) => x.id === gid);
  Object.assign(g, patch);
  store.saveData();
}

const createTag = async (rid, name) =>
  (await request(app).post(`/api/rounds/${rid}/tags`).send({ name })).body;

test('GET /legacy lists distinct platform/duration values with counts', async () => {
  const round = await createRound(request);
  const [a, b, c] = [await addGame(round.id, 'A'), await addGame(round.id, 'B'), await addGame(round.id, 'C')];
  setLegacy(round.id, a.id, { platform: 'steam' });
  setLegacy(round.id, b.id, { platform: 'steam', duration: 'short' });
  setLegacy(round.id, c.id, { duration: 'long' });

  const res = await request(app).get(`/api/rounds/${round.id}/legacy`);
  assert.equal(res.status, 200);
  const vals = res.body.values.sort((x, y) => (x.field + x.value).localeCompare(y.field + y.value));
  assert.deepEqual(vals, [
    { field: 'duration', value: 'long', count: 1 },
    { field: 'duration', value: 'short', count: 1 },
    { field: 'platform', value: 'steam', count: 2 },
  ]);
});

test('POST /legacy/migrate tags the affected games and clears the field', async () => {
  const round = await createRound(request);
  const [a, b] = [await addGame(round.id, 'A'), await addGame(round.id, 'B')];
  setLegacy(round.id, a.id, { platform: 'steam' });
  setLegacy(round.id, b.id, { platform: 'steam' });
  const tag = await createTag(round.id, 'Steam');

  const res = await request(app)
    .post(`/api/rounds/${round.id}/legacy/migrate`)
    .send({ field: 'platform', value: 'steam', tagId: tag.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.migrated, 2);

  const detail = await request(app).get(`/api/rounds/${round.id}`);
  detail.body.games.forEach((g) => {
    assert.equal('platform' in g, false);
    assert.deepEqual(g.tagIds, [tag.id]);
  });
  // The value is gone from the list now.
  const list = await request(app).get(`/api/rounds/${round.id}/legacy`);
  assert.deepEqual(list.body.values, []);
});

test('POST /legacy/migrate rejects an unknown tag, a bad field, and a missing round', async () => {
  const round = await createRound(request);
  const a = await addGame(round.id, 'A');
  setLegacy(round.id, a.id, { platform: 'steam' });
  const tag = await createTag(round.id, 'X');

  const badTag = await request(app)
    .post(`/api/rounds/${round.id}/legacy/migrate`)
    .send({ field: 'platform', value: 'steam', tagId: 'nope' });
  assert.equal(badTag.status, 400);

  const badField = await request(app)
    .post(`/api/rounds/${round.id}/legacy/migrate`)
    .send({ field: 'bogus', value: 'steam', tagId: tag.id });
  assert.equal(badField.status, 400);

  assert.equal((await request(app).get('/api/rounds/nope/legacy')).status, 404);
  const missingRound = await request(app)
    .post('/api/rounds/nope/legacy/migrate')
    .send({ field: 'platform', value: 'x', tagId: tag.id });
  assert.equal(missingRound.status, 404);
});
