'use strict';

/*
 * Request-body validation via zod (issue #213). These assert the exact
 * `{ error: <message> }` 400 shapes the mutating routers used to emit by hand
 * are preserved now that they run through `lib/validate.js` + colocated zod
 * schemas — the messages are the contract, so they're pinned here (the existing
 * route specs mostly assert only the status). Also covers the lenient
 * normalization paths (unknown enum -> default, non-array/-object -> empty) that
 * must stay 400-free, and a direct unit check of the shared helper.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const request = require('supertest');
const { app, createRound } = require('./helpers');
const { validateBody } = require('../lib/validate');

// Multipart add-game helper (mirrors games.test.js) so the create schema runs
// against form fields exactly as in production.
async function addGame(rid, fields = {}) {
  const req = request(app).post(`/api/rounds/${rid}/games`);
  const all = { title: 'Chess', minPlayers: '2', maxPlayers: '4', ...fields };
  for (const [k, v] of Object.entries(all)) req.field(k, String(v));
  return req;
}

/* ------------------------------ lib/validate ------------------------------- */

test('validateBody returns parsed data on success, sends 400 with the first issue on failure', () => {
  const schema = z.object({ n: z.number().int().min(1, 'bad n') });

  const okData = validateBody(schema, { body: { n: 3 } }, null);
  assert.deepEqual(okData, { n: 3 });

  let sent;
  const res = { status(code) { sent = { code }; return this; }, json(payload) { sent.body = payload; } };
  const bad = validateBody(schema, { body: { n: 0 } }, res);
  assert.equal(bad, null);
  assert.deepEqual(sent, { code: 400, body: { error: 'bad n' } });
});

test('validateBody tolerates a missing body', () => {
  const res = { status() { return this; }, json() {} };
  // Optional field -> empty body parses fine; no throw on req.body === undefined.
  assert.deepEqual(validateBody(z.object({ x: z.string().optional() }), {}, res), {});
});

/* -------------------------------- rounds ----------------------------------- */

test('rounds POST preserves the exact validation messages', async () => {
  const noName = await request(app).post('/api/rounds').send({ members: ['Ann'] });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error, 'Round name is missing');

  const noMembers = await request(app).post('/api/rounds').send({ name: 'Lonely' });
  assert.equal(noMembers.status, 400);
  assert.equal(noMembers.body.error, 'At least one member is required');

  // members entries are stringified/trimmed and blanks dropped before the check.
  const blankOnly = await request(app).post('/api/rounds').send({ name: 'X', members: ['', '  '] });
  assert.equal(blankOnly.status, 400);
  assert.equal(blankOnly.body.error, 'At least one member is required');
});

/* --------------------------------- games ----------------------------------- */

test('games POST preserves the exact validation messages', async () => {
  const round = await createRound(request);

  const noTitle = await addGame(round.id, { title: '   ' });
  assert.equal(noTitle.status, 400);
  assert.equal(noTitle.body.error, 'Title is missing');

  const badMin = await addGame(round.id, { minPlayers: '0' });
  assert.equal(badMin.status, 400);
  assert.equal(badMin.body.error, 'minPlayers is required (integer >= 1)');

  const badMax = await addGame(round.id, { minPlayers: '4', maxPlayers: '2' });
  assert.equal(badMax.status, 400);
  assert.equal(badMax.body.error, 'maxPlayers is required (integer >= minPlayers)');

  // Title is checked before the player range (first-issue ordering preserved).
  const both = await addGame(round.id, { title: '', minPlayers: '0' });
  assert.equal(both.body.error, 'Title is missing');
});

test('games POST falls back to defaults for an unknown platform/duration (no 400)', async () => {
  const round = await createRound(request);
  const res = await addGame(round.id, { platform: 'bogus', duration: 'eternal' });
  assert.equal(res.status, 201);
  assert.equal(res.body.platform, 'analog'); // default
  assert.equal(res.body.type, 'analog'); // derived from the default platform
  assert.equal(res.body.duration, 'medium'); // default
});

test('games PATCH preserves title/duration validation messages', async () => {
  const round = await createRound(request);
  const game = (await addGame(round.id)).body;

  const emptyTitle = await request(app)
    .patch(`/api/rounds/${round.id}/games/${game.id}`)
    .send({ title: '  ' });
  assert.equal(emptyTitle.status, 400);
  assert.equal(emptyTitle.body.error, 'Title is missing');

  const badDuration = await request(app)
    .patch(`/api/rounds/${round.id}/games/${game.id}`)
    .send({ duration: 'eternal' });
  assert.equal(badDuration.status, 400);
  assert.equal(badDuration.body.error, 'Invalid duration');
});

/* -------------------------------- sessions --------------------------------- */

test('sessions start stays lenient: junk votes/durations/count never 400 on shape', async () => {
  const round = await createRound(request);
  await addGame(round.id, { title: 'A', minPlayers: '1', maxPlayers: '8' });

  // count as a non-number string -> floored to 1; durations non-array -> ignored;
  // memberIds non-array -> everyone. None of these should 400.
  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions`)
    .send({ count: 'lots', durations: 'short', memberIds: 'nope' });
  assert.equal(res.status, 201);
  assert.equal(res.body.games.length, 1);
});

test('sessions results coerces a non-object votes payload to {} (still saves)', async () => {
  const round = await createRound(request);
  await addGame(round.id, { title: 'A', minPlayers: '1', maxPlayers: '8' });
  const session = (await request(app).post(`/api/rounds/${round.id}/sessions`).send({})).body.session;

  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions/${session.id}/results`)
    .send({ votes: 'not-an-object' });
  assert.equal(res.status, 200);
  assert.equal(res.body.done, true);
});

test('sessions finish coerces a non-array winnerIds to [] (still finishes)', async () => {
  const round = await createRound(request);
  await addGame(round.id, { title: 'A', minPlayers: '1', maxPlayers: '8' });
  const session = (await request(app).post(`/api/rounds/${round.id}/sessions`).send({})).body.session;

  const res = await request(app)
    .post(`/api/rounds/${round.id}/sessions/${session.id}/finish`)
    .send({ finished: true, winnerIds: 'not-an-array' });
  assert.equal(res.status, 200);
  assert.equal(res.body.finished, true);
  assert.deepEqual(res.body.winnerIds, []);
});
