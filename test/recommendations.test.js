'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, store, createRound } = require('./helpers');
// The router hangs its pure helpers off itself for unit testing (see the module).
const rec = require('../routes/recommendations');

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

test('POST generates, parses, filters owned, and caches a buy-next run', async () => {
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
  assert.ok(res.body.id, 'the run carries an id');
  // Recommendations are platform-agnostic now (#242): just a title and a reason,
  // the owned title filtered out.
  assert.deepEqual(res.body.items, [
    { title: 'Splendor', reason: 'Fast and tactical.' },
  ]);
  assert.ok(res.body.generatedAt);

  // GET returns the history (newest first) with the run just generated.
  const get = await request(app).get(`/api/rounds/${round.id}/recommendations`);
  assert.ok(Array.isArray(get.body));
  assert.equal(get.body.length, 1);
  assert.deepEqual(get.body[0].items, res.body.items);
});

test('generating twice appends a run — the earlier run is kept (no overwrite)', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { round } = await ratedRound();
  global.fetch = async () => anthropicReply([{ title: 'Splendor', reason: 'first run' }]);
  const first = await request(app).post(`/api/rounds/${round.id}/recommendations`);
  global.fetch = async () => anthropicReply([{ title: 'Wingspan', reason: 'second run' }]);
  const second = await request(app).post(`/api/rounds/${round.id}/recommendations`);

  const get = await request(app).get(`/api/rounds/${round.id}/recommendations`);
  assert.equal(get.body.length, 2);
  // Newest first.
  assert.equal(get.body[0].id, second.body.id);
  assert.equal(get.body[1].id, first.body.id);
  assert.equal(get.body[0].items[0].title, 'Wingspan');
  assert.equal(get.body[1].items[0].title, 'Splendor');
});

test('DELETE removes one run from the history and persists', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { round } = await ratedRound();
  global.fetch = async () => anthropicReply([{ title: 'Splendor', reason: 'a' }]);
  const first = await request(app).post(`/api/rounds/${round.id}/recommendations`);
  global.fetch = async () => anthropicReply([{ title: 'Wingspan', reason: 'b' }]);
  await request(app).post(`/api/rounds/${round.id}/recommendations`);

  const del = await request(app).delete(`/api/rounds/${round.id}/recommendations/${first.body.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.length, 1);

  const get = await request(app).get(`/api/rounds/${round.id}/recommendations`);
  assert.equal(get.body.length, 1);
  assert.equal(get.body[0].items[0].title, 'Wingspan');
});

test('DELETE of an unknown run or round is a 404', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { round } = await ratedRound();
  global.fetch = async () => anthropicReply([{ title: 'Splendor', reason: 'a' }]);
  await request(app).post(`/api/rounds/${round.id}/recommendations`);

  const badRun = await request(app).delete(`/api/rounds/${round.id}/recommendations/nope`);
  assert.equal(badRun.status, 404);
  const badRound = await request(app).delete('/api/rounds/nope/recommendations/whatever');
  assert.equal(badRound.status, 404);
});

test('a legacy single round.recommendations object reads as one run and folds in on write', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const round = await createRound(request);
  // Simulate pre-#115 data: the old single object, no recommendationRuns array.
  const stored = store.findRound(round.id);
  stored.recommendations = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    model: 'claude-haiku-4-5',
    locale: 'en',
    items: [{ title: 'Legacy Pick', platform: 'analog', reason: 'old', url: null }],
  };

  // GET reads it as a one-run history (synthetic 'legacy' id), without mutating.
  const get = await request(app).get(`/api/rounds/${round.id}/recommendations`);
  assert.equal(get.body.length, 1);
  assert.equal(get.body[0].id, 'legacy');
  assert.equal(get.body[0].items[0].title, 'Legacy Pick');
  assert.ok(stored.recommendations, 'GET does not migrate the legacy object');

  // A new generate folds the legacy run into the array and appends the new one.
  global.fetch = async () => anthropicReply([{ title: 'Fresh Pick', reason: 'new' }]);
  await request(app).post(`/api/rounds/${round.id}/recommendations`);
  const after = await request(app).get(`/api/rounds/${round.id}/recommendations`);
  assert.equal(after.body.length, 2);
  assert.equal(after.body[0].items[0].title, 'Fresh Pick');
  assert.equal(after.body[1].id, 'legacy');
  assert.ok(!stored.recommendations, 'the legacy object is retired once written');
  assert.ok(Array.isArray(stored.recommendationRuns));
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
  assert.deepEqual(get.body, []);
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

test('GET on a round with nothing generated returns an empty history', async () => {
  const round = await createRound(request);
  const res = await request(app).get(`/api/rounds/${round.id}/recommendations`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('unknown round returns 404', async () => {
  const res = await request(app).post('/api/rounds/nope/recommendations');
  assert.equal(res.status, 404);
});

test('POST is localized: prompt requests German reasons, items are platform-agnostic (#242)', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const round = await createRound(request);
  await addGame(round.id, { title: 'Gran Turismo 7' });
  await addGame(round.id, { title: 'Catan' });
  let sentBody = '';
  global.fetch = async (_url, opts) => {
    sentBody = opts.body;
    return anthropicReply([
      { title: 'Ratchet & Clank', reason: 'Bunter Plattformer.' },
      { title: 'Azul', reason: 'Elegantes Legespiel.' },
    ]);
  };
  const res = await request(app)
    .post(`/api/rounds/${round.id}/recommendations`)
    .send({ locale: 'de' });
  assert.equal(res.status, 200);

  const prompt = JSON.parse(sentBody).messages[0].content;
  assert.match(prompt, /Write each "reason" in German/);
  // No platform dimension in the prompt anymore.
  assert.doesNotMatch(prompt, /platform/i);

  assert.deepEqual(res.body.items, [
    { title: 'Ratchet & Clank', reason: 'Bunter Plattformer.' },
    { title: 'Azul', reason: 'Elegantes Legespiel.' },
  ]);
  assert.equal(res.body.locale, 'de');
});

test('buildProfile aggregates a member-anonymous taste profile without platform/type (#242)', () => {
  const round = {
    games: [
      { id: '1', title: 'A', minPlayers: 2, maxPlayers: 4 },
      { id: '2', title: 'B', minPlayers: 2, maxPlayers: 4 },
      { id: '3', title: 'C', retired: true }, // retired ignored
    ],
    members: [],
    sessions: [],
  };
  const profile = rec.buildProfile(round);
  assert.deepEqual(profile.owned, ['A', 'B']);
  assert.equal(profile.typicalPlayers, '2-4');
  // The retired platform/type/duration dimensions are gone from the profile.
  assert.equal('platforms' in profile, false);
  assert.equal('favoriteType' in profile, false);
  assert.equal('favoriteDuration' in profile, false);
});

test('parseItems keeps title+reason, filters owned, and dedupes titles (#242)', () => {
  const data = {
    content: [
      {
        type: 'text',
        text: JSON.stringify([
          { title: 'Hades', reason: 'a' },
          { title: 'Hades', reason: 'dupe title, dropped' },
          { title: 'Owned', reason: 'owned, dropped' },
        ]),
      },
    ],
  };
  const items = rec.parseItems(data, ['owned']);
  assert.deepEqual(items, [{ title: 'Hades', reason: 'a' }]);
});
