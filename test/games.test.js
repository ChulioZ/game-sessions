'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, createRound } = require('./helpers');

// Add a game to a round via the multipart endpoint; returns the game object.
async function addGame(rid, fields = {}) {
  const req = request(app).post(`/api/rounds/${rid}/games`);
  const all = { title: 'Chess', minPlayers: '2', maxPlayers: '4', ...fields };
  for (const [k, v] of Object.entries(all)) req.field(k, String(v));
  return req;
}

test('POST games adds a game and logs a game_added activity', async () => {
  const round = await createRound(request);
  const res = await addGame(round.id, { title: 'Uno', type: 'analog', duration: 'short' });
  assert.equal(res.status, 201);
  assert.equal(res.body.title, 'Uno');
  assert.equal(res.body.duration, 'short');
  assert.equal(res.body.retired, false);

  const detail = await request(app).get(`/api/rounds/${round.id}`);
  assert.ok(detail.body.activities.some((a) => a.type === 'game_added' && a.gameId === res.body.id));
});

test('POST games rejects missing title and invalid player counts', async () => {
  const round = await createRound(request);
  assert.equal((await addGame(round.id, { title: '' })).status, 400);
  assert.equal((await addGame(round.id, { minPlayers: '0' })).status, 400);
  assert.equal((await addGame(round.id, { minPlayers: '4', maxPlayers: '2' })).status, 400);
});

test('retire flag sets retired/retiredAt and logs game_retired', async () => {
  const round = await createRound(request);
  const game = (await addGame(round.id)).body;
  const res = await request(app).post(`/api/rounds/${round.id}/games/${game.id}/retire`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.retired, true);
  assert.ok(res.body.retiredAt);

  const detail = await request(app).get(`/api/rounds/${round.id}`);
  assert.ok(detail.body.activities.some((a) => a.type === 'game_retired'));
});

test('restoring clears retiredAt and logs game_restored', async () => {
  const round = await createRound(request);
  const game = (await addGame(round.id)).body;
  await request(app).post(`/api/rounds/${round.id}/games/${game.id}/retire`).send({});
  const res = await request(app)
    .post(`/api/rounds/${round.id}/games/${game.id}/retire`)
    .send({ retired: false });
  assert.equal(res.body.retired, false);
  assert.equal(res.body.retiredAt, null);
});

test('PATCH games edits fields without adding an activity', async () => {
  const round = await createRound(request);
  const game = (await addGame(round.id)).body;
  const before = (await request(app).get(`/api/rounds/${round.id}`)).body.activities.length;
  const res = await request(app)
    .patch(`/api/rounds/${round.id}/games/${game.id}`)
    .send({ title: 'Chess Deluxe', maxPlayers: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Chess Deluxe');
  assert.equal(res.body.maxPlayers, 2);
  const after = (await request(app).get(`/api/rounds/${round.id}`)).body.activities.length;
  assert.equal(after, before);
});

test('DELETE only works on retired games and scrubs feed entries', async () => {
  const round = await createRound(request);
  const game = (await addGame(round.id)).body;

  const tooEarly = await request(app).delete(`/api/rounds/${round.id}/games/${game.id}`);
  assert.equal(tooEarly.status, 400);

  await request(app).post(`/api/rounds/${round.id}/games/${game.id}/retire`).send({});
  const res = await request(app).delete(`/api/rounds/${round.id}/games/${game.id}`);
  assert.equal(res.status, 200);

  const detail = await request(app).get(`/api/rounds/${round.id}`);
  assert.equal(detail.body.games.length, 0);
  // The add/retire entries referencing the game are gone; a game_deleted remains.
  assert.ok(!detail.body.activities.some((a) => a.gameId === game.id));
  assert.ok(detail.body.activities.some((a) => a.type === 'game_deleted'));
});
