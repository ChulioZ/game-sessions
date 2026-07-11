'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, createRound } = require('./helpers');

async function addGame(rid, fields = {}) {
  const req = request(app).post(`/api/rounds/${rid}/games`);
  const all = { title: 'Game', minPlayers: '1', maxPlayers: '8', ...fields };
  for (const [k, v] of Object.entries(all)) req.field(k, String(v));
  return (await req).body;
}

test('starting a session picks from matching games and returns them', async () => {
  const round = await createRound(request);
  await addGame(round.id, { title: 'A', type: 'analog' });
  await addGame(round.id, { title: 'B', type: 'digital' });

  const res = await request(app).post(`/api/rounds/${round.id}/sessions`).send({ count: 5 });
  assert.equal(res.status, 201);
  assert.equal(res.body.games.length, 2);
  assert.equal(res.body.session.gameIds.length, 2);
});

test('type filter narrows the pool', async () => {
  const round = await createRound(request);
  await addGame(round.id, { title: 'A', type: 'analog' });
  await addGame(round.id, { title: 'B', type: 'digital' });
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions`)
    .send({ filter: 'digital', count: 5 });
  assert.equal(res.body.games.length, 1);
  assert.equal(res.body.games[0].type, 'digital');
});

test('player count filters games by their min/max range', async () => {
  const round = await createRound(request);
  await addGame(round.id, { title: 'Solo', minPlayers: '1', maxPlayers: '1' });
  await addGame(round.id, { title: 'Party', minPlayers: '4', maxPlayers: '8' });
  // Both members join -> playerCount 2 -> neither game's range covers 2, so
  // the pool is empty and the endpoint reports "no matching games".
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions`)
    .send({ memberIds: round.members.map((m) => m.id), count: 5 });
  assert.equal(res.status, 400);
});

test('player count includes games whose range covers the joining members', async () => {
  const round = await createRound(request);
  await addGame(round.id, { title: 'Pair', minPlayers: '2', maxPlayers: '2' });
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions`)
    .send({ memberIds: round.members.map((m) => m.id), count: 5 });
  assert.equal(res.status, 201);
  assert.equal(res.body.games.length, 1);
});

test('a session with no matching games returns 400', async () => {
  const round = await createRound(request);
  const res = await request(app).post(`/api/rounds/${round.id}/sessions`).send({});
  assert.equal(res.status, 400);
});

test('choice must reference a game from the session', async () => {
  const round = await createRound(request);
  const game = await addGame(round.id);
  const session = (await request(app).post(`/api/rounds/${round.id}/sessions`).send({})).body.session;

  const bad = await request(app)
    .post(`/api/rounds/${round.id}/sessions/${session.id}/choice`)
    .send({ gameId: 'nope' });
  assert.equal(bad.status, 400);

  const ok = await request(app)
    .post(`/api/rounds/${round.id}/sessions/${session.id}/choice`)
    .send({ gameId: game.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.chosenGameId, game.id);
});

test('cancel is blocked once a game is chosen', async () => {
  const round = await createRound(request);
  const game = await addGame(round.id);
  const session = (await request(app).post(`/api/rounds/${round.id}/sessions`).send({})).body.session;
  await request(app)
    .post(`/api/rounds/${round.id}/sessions/${session.id}/choice`)
    .send({ gameId: game.id });
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions/${session.id}/cancel`)
    .send({});
  assert.equal(res.status, 400);
});

test('finish records only winners who are round members', async () => {
  const round = await createRound(request);
  await addGame(round.id);
  const session = (await request(app).post(`/api/rounds/${round.id}/sessions`).send({})).body.session;
  const memberId = round.members[0].id;
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions/${session.id}/finish`)
    .send({ winnerIds: [memberId, 'stranger'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.finished, true);
  assert.deepEqual(res.body.winnerIds, [memberId]);
});

test('deleting a game from a session drops it and its votes', async () => {
  const round = await createRound(request);
  const keep = await addGame(round.id, { title: 'Keep' });
  const drop = await addGame(round.id, { title: 'Drop' });
  const session = (await request(app).post(`/api/rounds/${round.id}/sessions`).send({ count: 5 })).body.session;
  const [m0, m1] = round.members.map((m) => m.id);
  const votes = {
    [m0]: { [keep.id]: { rating: 4, retire: false }, [drop.id]: { rating: 2, retire: true } },
    [m1]: { [drop.id]: { rating: 5, retire: false } },
  };
  await request(app).post(`/api/rounds/${round.id}/sessions/${session.id}/results`).send({ votes });

  const res = await request(app).delete(`/api/rounds/${round.id}/sessions/${session.id}/games/${drop.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.gameIds, [keep.id]);
  assert.equal(res.body.votes[m0][drop.id], undefined);
  assert.equal(res.body.votes[m1][drop.id], undefined);
  assert.deepEqual(res.body.votes[m0][keep.id], { rating: 4, retire: false });
});

test('deleting the chosen game resets the choice and result', async () => {
  const round = await createRound(request);
  const game = await addGame(round.id);
  const session = (await request(app).post(`/api/rounds/${round.id}/sessions`).send({})).body.session;
  await request(app).post(`/api/rounds/${round.id}/sessions/${session.id}/choice`).send({ gameId: game.id });
  await request(app)
    .post(`/api/rounds/${round.id}/sessions/${session.id}/finish`)
    .send({ winnerIds: [round.members[0].id] });

  const res = await request(app).delete(`/api/rounds/${round.id}/sessions/${session.id}/games/${game.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.gameIds, []);
  assert.equal(res.body.chosenGameId, null);
  assert.equal(res.body.finished, false);
  assert.deepEqual(res.body.winnerIds, []);
});

test('deleting a game not in the session returns 404', async () => {
  const round = await createRound(request);
  await addGame(round.id);
  const session = (await request(app).post(`/api/rounds/${round.id}/sessions`).send({})).body.session;
  const res = await request(app).delete(`/api/rounds/${round.id}/sessions/${session.id}/games/nope`);
  assert.equal(res.status, 404);
});

test('results persist votes and mark the session done', async () => {
  const round = await createRound(request);
  const game = await addGame(round.id);
  const session = (await request(app).post(`/api/rounds/${round.id}/sessions`).send({})).body.session;
  const votes = { [round.members[0].id]: { [game.id]: { rating: 5, retire: false } } };
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions/${session.id}/results`)
    .send({ votes });
  assert.equal(res.body.done, true);
  assert.deepEqual(res.body.votes, votes);
});

// --- Direct-pick mode ("Jetzt spielen": one game, no vote) ---

test('direct pick starts a done session with the game already chosen', async () => {
  const round = await createRound(request);
  const game = await addGame(round.id, { title: 'Chosen' });
  const other = await addGame(round.id, { title: 'Other' });

  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions`)
    .send({ gameId: game.id });
  assert.equal(res.status, 201);
  const s = res.body.session;
  assert.deepEqual(s.gameIds, [game.id]);
  assert.equal(s.chosenGameId, game.id);
  assert.ok(s.chosenAt);
  assert.equal(s.done, true);
  assert.deepEqual(s.votes, {});
  assert.equal(s.requestedCount, 1);
  // Only the picked game is returned, not the rest of the round.
  assert.equal(res.body.games.length, 1);
  assert.equal(res.body.games[0].id, game.id);
  assert.ok(!s.gameIds.includes(other.id));
});

test('direct pick ignores draw filters and never draws extra games', async () => {
  const round = await createRound(request);
  const game = await addGame(round.id, { title: 'Solo', minPlayers: '1', maxPlayers: '1' });
  await addGame(round.id, { title: 'Filler' });
  // A player-range that a draw would reject, plus count/filter noise: all ignored.
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions`)
    .send({ gameId: game.id, count: 5, filter: 'digital', memberIds: round.members.map((m) => m.id) });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.session.gameIds, [game.id]);
  assert.equal(res.body.session.memberIds.length, round.members.length);
});

test('direct pick only counts the joining members', async () => {
  const round = await createRound(request);
  const game = await addGame(round.id);
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions`)
    .send({ gameId: game.id, memberIds: [round.members[0].id] });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.session.memberIds, [round.members[0].id]);
});

test('direct pick rejects an unknown game', async () => {
  const round = await createRound(request);
  await addGame(round.id);
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions`)
    .send({ gameId: 'nope' });
  assert.equal(res.status, 400);
});

test('direct pick rejects a retired game', async () => {
  const round = await createRound(request);
  const game = await addGame(round.id);
  await request(app).post(`/api/rounds/${round.id}/games/${game.id}/retire`).send({ retired: true });
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions`)
    .send({ gameId: game.id });
  assert.equal(res.status, 400);
});

test('direct pick with only unknown member ids falls back to everyone', async () => {
  const round = await createRound(request);
  const game = await addGame(round.id);
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions`)
    .send({ gameId: game.id, memberIds: ['ghost'] });
  assert.equal(res.status, 201);
  assert.equal(res.body.session.memberIds.length, round.members.length);
});
