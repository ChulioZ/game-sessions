'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('./helpers');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

// Replace global.fetch (used by lib/providers/psstore) with a stub returning
// store HTML built from an Apollo-cache-shaped object.
function stubFetch(handler) {
  global.fetch = async (url) => handler(String(url));
}
const htmlRes = (text) => ({ ok: true, status: 200, text: async () => text });

function page(apolloState, body = '') {
  const next = { props: { pageProps: { apolloState } } };
  return `<html><body>${body}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></body></html>`;
}

const PROD = {
  __typename: 'Product',
  id: 'UP4497-PPSA10407_00-0000000000000001',
  name: 'The Witcher 3: Wild Hunt',
  storeDisplayClassification: 'FULL_GAME',
  media: [{ __typename: 'Media', role: 'MASTER', type: 'IMAGE', url: 'https://image.api.playstation.com/vulcan/w.png' }],
};

test('GET /api/lookup/search returns normalized results', async () => {
  stubFetch((url) => {
    assert.match(url, /\/search\//);
    return htmlRes(page({ 'Product:X': PROD }));
  });
  const res = await request(app).get('/api/lookup/search?provider=psstore&q=witcher');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, [
    { providerId: PROD.id, title: 'The Witcher 3: Wild Hunt', thumbnail: 'https://image.api.playstation.com/vulcan/w.png' },
  ]);
});

test('search with a too-short query short-circuits without calling the provider', async () => {
  let called = false;
  stubFetch(() => { called = true; return htmlRes(page({})); });
  const res = await request(app).get('/api/lookup/search?provider=psstore&q=a');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, []);
  assert.equal(called, false);
});

test('search rejects an unknown provider', async () => {
  const res = await request(app).get('/api/lookup/search?provider=nope&q=witcher');
  assert.equal(res.status, 400);
});

test('search returns 502 when the provider is unreachable', async () => {
  stubFetch(() => { throw new Error('network down'); });
  const res = await request(app).get('/api/lookup/search?provider=psstore&q=zzzunreachable');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'provider_unreachable');
});

test('GET /api/lookup/game returns normalized detail (digital, players, no duration)', async () => {
  stubFetch((url) => {
    assert.match(url, /\/product\//);
    return htmlRes(page({ 'Product:X': PROD }, '<span class="compatText">1 - 4 players</span>'));
  });
  const res = await request(app).get(`/api/lookup/game?provider=psstore&id=${PROD.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'The Witcher 3: Wild Hunt');
  assert.equal(res.body.type, 'digital');
  assert.equal(res.body.duration, null);
  assert.equal(res.body.minPlayers, 1);
  assert.equal(res.body.maxPlayers, 4);
  assert.equal(res.body.imageUrl, 'https://image.api.playstation.com/vulcan/w.png');
  assert.match(res.body.url, /\/product\/UP4497-PPSA10407_00-0000000000000001$/);
});

test('game still returns a usable digital detail when the page has no product stub', async () => {
  stubFetch(() => htmlRes('<html><body><span class="compatText">1 - 4 players</span></body></html>'));
  const res = await request(app).get('/api/lookup/game?provider=psstore&id=NOPE');
  assert.equal(res.status, 200);
  assert.equal(res.body.type, 'digital');
  assert.equal(res.body.minPlayers, 1);
  assert.equal(res.body.maxPlayers, 4);
  assert.equal(res.body.title, null);
});

test('game requires an id', async () => {
  const res = await request(app).get('/api/lookup/game?provider=psstore');
  assert.equal(res.status, 400);
});
