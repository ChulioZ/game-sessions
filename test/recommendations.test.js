'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, createRound } = require('./helpers');

// The route calls the global fetch (like the lookup providers), so stub it and
// restore afterwards — nothing ever hits the real Anthropic API. Also restore
// ANTHROPIC_API_KEY, which individual tests set or clear.
const realFetch = global.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

async function addGame(rid, fields = {}) {
  const req = request(app).post(`/api/rounds/${rid}/games`);
  const all = { title: 'Game', minPlayers: '2', maxPlayers: '4', ...fields };
  for (const [k, v] of Object.entries(all)) req.field(k, String(v));
  return (await req).body;
}

// A round with two rated games, so buildProfile has real data to aggregate.
async function ratedRound() {
  const round = await createRound(request); // members: Alice, Bob
  const a = await addGame(round.id, { title: 'Azul', type: 'analog' });
  const b = await addGame(round.id, { title: 'Catan', type: 'analog' });
  const start = await request(app).post(`/api/rounds/${round.id}/sessions`).send({ count: 5 });
  const session = start.body.session;
  const [m0, m1] = round.members.map((m) => m.id);
  const votes = {
    [m0]: { [a.id]: { rating: 5, retire: false }, [b.id]: { rating: 2, retire: false } },
    [m1]: { [a.id]: { rating: 4, retire: false }, [b.id]: { rating: 3, retire: false } },
  };
  await request(app).post(`/api/rounds/${round.id}/sessions/${session.id}/results`).send({ votes });
  return { round, members: [m0, m1] };
}

const anthropicReply = (items) => ({
  ok: true,
  status: 200,
  json: async () => ({
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: JSON.stringify(items) }],
  }),
});

test('POST generates, parses, filters owned, and caches a buy-next list', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { round } = await ratedRound();
  global.fetch = async () =>
    anthropicReply([
      { title: 'Splendor', reason: 'Fast and tactical.' },
      { title: 'Azul', reason: 'You already own this.' }, // owned -> dropped
    ]);
  const res = await request(app).post(`/api/rounds/${round.id}/recommendations`);
  assert.equal(res.status, 200);
  assert.equal(res.body.model, 'claude-haiku-4-5');
  assert.deepEqual(res.body.items, [{ title: 'Splendor', reason: 'Fast and tactical.' }]);
  assert.ok(res.body.generatedAt);

  // GET returns the cached list.
  const get = await request(app).get(`/api/rounds/${round.id}/recommendations`);
  assert.deepEqual(get.body.items, res.body.items);
});

test('the outbound payload contains no member identifiers', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { round, members } = await ratedRound();
  let sentBody = '';
  global.fetch = async (_url, opts) => {
    sentBody = opts.body;
    return anthropicReply([{ title: 'Splendor', reason: 'x' }]);
  };
  await request(app).post(`/api/rounds/${round.id}/recommendations`);
  for (const id of members) assert.ok(!sentBody.includes(id), `member id ${id} leaked into the payload`);
  // Aggregated taste (game titles) is expected to be present.
  assert.ok(sentBody.includes('Azul'));
});

test('missing ANTHROPIC_API_KEY returns 503 not_configured and never calls fetch', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const { round } = await ratedRound();
  let called = false;
  global.fetch = async () => {
    called = true;
    return anthropicReply([]);
  };
  const res = await request(app).post(`/api/rounds/${round.id}/recommendations`);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'not_configured');
  assert.equal(called, false);
});

test('an upstream failure is a soft 502 and writes no cache', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { round } = await ratedRound();
  global.fetch = async () => {
    throw new Error('network down');
  };
  const res = await request(app).post(`/api/rounds/${round.id}/recommendations`);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'provider_unreachable');
  const get = await request(app).get(`/api/rounds/${round.id}/recommendations`);
  assert.equal(get.body, null);
});

test('an unparseable reply is a soft 502, not a crash', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { round } = await ratedRound();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text: 'sorry, no JSON here' }] }),
  });
  const res = await request(app).post(`/api/rounds/${round.id}/recommendations`);
  assert.equal(res.status, 502);
});

test('GET on a round with nothing generated returns null', async () => {
  const round = await createRound(request);
  const res = await request(app).get(`/api/rounds/${round.id}/recommendations`);
  assert.equal(res.status, 200);
  assert.equal(res.body, null);
});

test('unknown round returns 404', async () => {
  const res = await request(app).post('/api/rounds/nope/recommendations');
  assert.equal(res.status, 404);
});
