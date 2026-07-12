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

// --- Provider source + server-side cover download (issue #41 follow-up) ---

const fs = require('node:fs');
const path = require('node:path');
const { store } = require('./helpers');

test('POST games stores a provider source link', async () => {
  const round = await createRound(request);
  const res = await addGame(round.id, {
    title: 'The Witcher 3',
    type: 'digital',
    sourceProvider: 'psstore',
    sourceExternalId: 'UP4497-PPSA10407_00-0000000000000001',
    sourceUrl: 'https://store.playstation.com/de-de/product/UP4497-PPSA10407_00-0000000000000001',
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.source, {
    provider: 'psstore',
    externalId: 'UP4497-PPSA10407_00-0000000000000001',
    url: 'https://store.playstation.com/de-de/product/UP4497-PPSA10407_00-0000000000000001',
  });
});

test('POST games ignores an unknown source provider and a non-http source url', async () => {
  const round = await createRound(request);
  const bad = await addGame(round.id, { sourceProvider: 'evil', sourceExternalId: '1' });
  assert.equal(bad.body.source, undefined);

  const noUrl = await addGame(round.id, {
    sourceProvider: 'psstore',
    sourceExternalId: 'X',
    sourceUrl: 'javascript:alert(1)',
  });
  assert.equal(noUrl.body.source.url, null); // rejected, but the link id is kept
});

test('POST games stores a BoardGameGeek source link', async () => {
  const round = await createRound(request);
  const res = await addGame(round.id, {
    title: 'Catan',
    type: 'analog',
    sourceProvider: 'bgg',
    sourceExternalId: '13',
    sourceUrl: 'https://boardgamegeek.com/boardgame/13/catan',
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.source, {
    provider: 'bgg',
    externalId: '13',
    url: 'https://boardgamegeek.com/boardgame/13/catan',
  });
});

test('POST games downloads a cover from the BoardGameGeek image host', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  });
  try {
    const round = await createRound(request);
    const res = await addGame(round.id, {
      title: 'Catan',
      imageUrl: 'https://cf.geekdo-images.com/x/pic.jpg',
    });
    assert.equal(res.status, 201);
    assert.match(res.body.image, /^\/uploads\/[0-9a-f]+\.jpg$/);
    assert.ok(fs.existsSync(path.join(store.UPLOAD_DIR, path.basename(res.body.image))));
  } finally {
    global.fetch = realFetch;
  }
});

test('POST games downloads a cover from the Steam image host', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  });
  try {
    const round = await createRound(request);
    const res = await addGame(round.id, {
      title: 'Stardew Valley',
      imageUrl: 'https://shared.akamai.steamstatic.com/apps/413150/header.jpg',
    });
    assert.equal(res.status, 201);
    assert.match(res.body.image, /^\/uploads\/[0-9a-f]+\.jpg$/);
    assert.ok(fs.existsSync(path.join(store.UPLOAD_DIR, path.basename(res.body.image))));
  } finally {
    global.fetch = realFetch;
  }
});

test('POST games downloads a cover from an allowlisted host', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  });
  try {
    const round = await createRound(request);
    const res = await addGame(round.id, {
      title: 'The Witcher 3',
      imageUrl: 'https://image.api.playstation.com/vulcan/witcher.png',
    });
    assert.equal(res.status, 201);
    assert.match(res.body.image, /^\/uploads\/[0-9a-f]+\.png$/);
    const file = path.join(store.UPLOAD_DIR, path.basename(res.body.image));
    assert.ok(fs.existsSync(file));
  } finally {
    global.fetch = realFetch;
  }
});

test('POST games does not download a cover from a non-allowlisted host', async () => {
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should not fetch'); };
  try {
    const round = await createRound(request);
    const res = await addGame(round.id, {
      title: 'The Witcher 3',
      imageUrl: 'https://evil.example.com/x.png',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.image, null);
    assert.equal(called, false);
  } finally {
    global.fetch = realFetch;
  }
});

// --- Link an existing game to a provider via PATCH (issue #74) ---

test('PATCH links an unlinked game to a provider source', async () => {
  const round = await createRound(request);
  const game = (await addGame(round.id)).body;
  assert.equal(game.source, undefined);

  const res = await request(app)
    .patch(`/api/rounds/${round.id}/games/${game.id}`)
    .send({
      sourceProvider: 'bgg',
      sourceExternalId: '13',
      sourceUrl: 'https://boardgamegeek.com/boardgame/13/catan',
      type: 'analog',
      duration: 'long',
    });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.source, {
    provider: 'bgg',
    externalId: '13',
    url: 'https://boardgamegeek.com/boardgame/13/catan',
  });
  assert.equal(res.body.duration, 'long');
});

test('PATCH ignores an invalid source and does not clobber the field', async () => {
  const round = await createRound(request);
  const game = (await addGame(round.id)).body;
  const res = await request(app)
    .patch(`/api/rounds/${round.id}/games/${game.id}`)
    .send({ sourceProvider: 'evil', sourceExternalId: '1', title: 'Renamed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.source, undefined); // unknown provider → no link stored
  assert.equal(res.body.title, 'Renamed'); // other fields still applied
});

test('PATCH downloads a cover from an allowlisted imageUrl', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  });
  try {
    const round = await createRound(request);
    const game = (await addGame(round.id)).body;
    const res = await request(app)
      .patch(`/api/rounds/${round.id}/games/${game.id}`)
      .send({ imageUrl: 'https://cf.geekdo-images.com/x/pic.jpg' });
    assert.equal(res.status, 200);
    assert.match(res.body.image, /^\/uploads\/[0-9a-f]+\.jpg$/);
    assert.ok(fs.existsSync(path.join(store.UPLOAD_DIR, path.basename(res.body.image))));
  } finally {
    global.fetch = realFetch;
  }
});

test('PATCH keeps the old cover when an imageUrl host is not allowlisted', async () => {
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should not fetch'); };
  try {
    const round = await createRound(request);
    const game = (await addGame(round.id)).body;
    const res = await request(app)
      .patch(`/api/rounds/${round.id}/games/${game.id}`)
      .send({ imageUrl: 'https://evil.example.com/x.png' });
    assert.equal(res.status, 200);
    assert.equal(res.body.image, null); // unchanged (never had one)
    assert.equal(called, false);
  } finally {
    global.fetch = realFetch;
  }
});
