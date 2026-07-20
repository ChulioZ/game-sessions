'use strict';

/*
 * Per-round lookup-provider configuration (issue #294): the
 * PUT /api/rounds/:rid/providers route and the enforcement it buys on the
 * round-scoped lookup routes.
 *
 * The point of the enforcement tests is that a disabled provider is REFUSED
 * server-side rather than merely hidden in the UI — a client that asks anyway
 * (stale tab, hand-rolled call) must not get an answer, and must not cause the
 * upstream request at all.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, createRound } = require('./helpers');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const setProviders = (rid, providers) =>
  request(app).put(`/api/rounds/${rid}/providers`).send({ providers });

test('a fresh round has no providers key at all (absent = all enabled)', async () => {
  const round = await createRound(request);
  const res = await request(app).get(`/api/rounds/${round.id}`);
  assert.equal(res.status, 200);
  // Absent, not `[]` and not the full list — absent is what "never configured"
  // means, and the JSON/Postgres backends must agree on that (contract suite).
  assert.equal('providers' in res.body, false);
});

test('PUT stores the list and it survives a reload', async () => {
  const round = await createRound(request);
  const res = await setProviders(round.id, ['bgg', 'steam']);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.providers, ['bgg', 'steam']);

  const reload = await request(app).get(`/api/rounds/${round.id}`);
  assert.deepEqual(reload.body.providers, ['bgg', 'steam']);
});

test('an empty list is a real setting, distinct from never-configured', async () => {
  const round = await createRound(request);
  const res = await setProviders(round.id, []);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.providers, []);

  const reload = await request(app).get(`/api/rounds/${round.id}`);
  assert.equal('providers' in reload.body, true);
  assert.deepEqual(reload.body.providers, []);
});

test('duplicate ids collapse to a set', async () => {
  const round = await createRound(request);
  const res = await setProviders(round.id, ['bgg', 'bgg', 'steam', 'bgg']);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.providers, ['bgg', 'steam']);
});

test('an unknown provider id is rejected with a 400', async () => {
  const round = await createRound(request);
  const res = await setProviders(round.id, ['bgg', 'nope']);
  assert.equal(res.status, 400);

  // …and nothing was stored.
  const reload = await request(app).get(`/api/rounds/${round.id}`);
  assert.equal('providers' in reload.body, false);
});

test('PUT on a missing round is a 404', async () => {
  const res = await setProviders('nope', ['bgg']);
  assert.equal(res.status, 404);
});

test('a disabled provider is refused server-side and never reaches upstream', async () => {
  const round = await createRound(request);
  await setProviders(round.id, ['bgg']);

  let called = false;
  global.fetch = async () => { called = true; return { ok: true, text: async () => '' }; };

  const search = await request(app)
    .get(`/api/rounds/${round.id}/lookup/search?provider=psstore&q=witcher`);
  assert.equal(search.status, 403);
  assert.equal(search.body.error, 'provider_disabled');

  const detail = await request(app)
    .get(`/api/rounds/${round.id}/lookup/game?provider=psstore&id=X`);
  assert.equal(detail.status, 403);
  assert.equal(detail.body.error, 'provider_disabled');

  assert.equal(called, false);
});

test('an enabled provider still answers on a configured round', async () => {
  const round = await createRound(request);
  await setProviders(round.id, ['bgg']);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: { bindings: [{ bgg: { value: '13' }, itemLabel: { value: 'Catan' } }] } }),
  });
  const res = await request(app)
    .get(`/api/rounds/${round.id}/lookup/search?provider=bgg&q=catan`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, [{ providerId: '13', title: 'Catan', thumbnail: null }]);
});

test('with no providers enabled every lookup is refused', async () => {
  const round = await createRound(request);
  await setProviders(round.id, []);
  const res = await request(app)
    .get(`/api/rounds/${round.id}/lookup/search?provider=bgg&q=catan`);
  assert.equal(res.status, 403);
});

test('the lookup 404s for a round that does not exist', async () => {
  const res = await request(app).get('/api/rounds/nope/lookup/search?provider=bgg&q=catan');
  assert.equal(res.status, 404);
});

test('an unknown provider is still a 400, not a 403', async () => {
  const round = await createRound(request);
  await setProviders(round.id, ['bgg']);
  const res = await request(app)
    .get(`/api/rounds/${round.id}/lookup/search?provider=nope&q=catan`);
  assert.equal(res.status, 400);
});
