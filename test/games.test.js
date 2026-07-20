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
  const res = await addGame(round.id, { title: 'Uno' });
  assert.equal(res.status, 201);
  assert.equal(res.body.title, 'Uno');
  assert.equal(res.body.retired, false);
  // platform/duration/type are retired fields (#242) — never stored on new games.
  assert.equal('platform' in res.body, false);
  assert.equal('duration' in res.body, false);
  assert.equal('type' in res.body, false);

  // The feed lives on its own endpoint (#197), not in the round payload.
  const detail = await request(app).get(`/api/rounds/${round.id}`);
  assert.equal('activities' in detail.body, false);
  const feed = await request(app).get(`/api/rounds/${round.id}/activities`);
  assert.ok(feed.body.some((a) => a.type === 'game_added' && a.gameId === res.body.id));
});

test('GET activities 404s for a missing round', async () => {
  const res = await request(app).get('/api/rounds/nope/activities');
  assert.equal(res.status, 404);
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

  const feed = await request(app).get(`/api/rounds/${round.id}/activities`);
  assert.ok(feed.body.some((a) => a.type === 'game_retired'));
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
  const before = (await request(app).get(`/api/rounds/${round.id}/activities`)).body.length;
  const res = await request(app)
    .patch(`/api/rounds/${round.id}/games/${game.id}`)
    .send({ title: 'Chess Deluxe', maxPlayers: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Chess Deluxe');
  assert.equal(res.body.maxPlayers, 2);
  const after = (await request(app).get(`/api/rounds/${round.id}/activities`)).body.length;
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
  const feed = (await request(app).get(`/api/rounds/${round.id}/activities`)).body;
  assert.ok(!feed.some((a) => a.gameId === game.id));
  assert.ok(feed.some((a) => a.type === 'game_deleted'));
});

// --- Provider source + server-side cover download (issue #41 follow-up) ---

const fs = require('node:fs');
const path = require('node:path');
const { store } = require('./helpers');

test('POST games ignores retired platform/duration/type fields (#242)', async () => {
  const round = await createRound(request);
  // The schema strips these unknown keys, so nothing is stored on the new game.
  const res = await addGame(round.id, { title: 'Ludo', platform: 'ps', duration: 'short', type: 'digital' });
  assert.equal(res.status, 201);
  assert.equal(res.body.title, 'Ludo');
  assert.equal('platform' in res.body, false);
  assert.equal('duration' in res.body, false);
  assert.equal('type' in res.body, false);
});

test('PATCH ignores retired platform/duration/type fields (#242)', async () => {
  const round = await createRound(request);
  const game = (await addGame(round.id)).body;
  const res = await request(app)
    .patch(`/api/rounds/${round.id}/games/${game.id}`)
    .send({ title: 'Renamed', platform: 'steam', duration: 'long', type: 'analog' });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Renamed'); // a real field still applies
  assert.equal('platform' in res.body, false);
  assert.equal('duration' in res.body, false);
  assert.equal('type' in res.body, false);
});

test('POST games stores a provider source link', async () => {
  const round = await createRound(request);
  const res = await addGame(round.id, {
    title: 'The Witcher 3',
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

// Provider cover art is HOTLINKED, never re-hosted (#172): the provider's own
// https URL is what gets stored, and the server must not fetch a single byte.
// One case per provider image host, so the allowlist stays covered.
const COVER_HOSTS = [
  ['BoardGameGeek', 'https://cf.geekdo-images.com/x/pic.jpg'],
  ['Steam', 'https://cdn.akamai.steamstatic.com/steam/apps/570/header.jpg'],
  ['Nintendo', 'https://www.nintendo.com/eu/media/images/mk8_square.jpg'],
  ['Xbox', 'https://store-images.s-microsoft.com/image/apps.9999.infinite.jpg'],
  ['PlayStation', 'https://image.api.playstation.com/vulcan/witcher.png'],
];

for (const [label, imageUrl] of COVER_HOSTS) {
  test(`POST games stores a ${label} cover as a hotlink without downloading it`, async () => {
    const realFetch = global.fetch;
    let called = false;
    global.fetch = async () => { called = true; throw new Error('must not download a cover'); };
    try {
      const round = await createRound(request);
      const res = await addGame(round.id, { title: `Cover via ${label}`, imageUrl });
      assert.equal(res.status, 201);
      // Stored verbatim, so the browser fetches it from the provider.
      assert.equal(res.body.image, imageUrl);
      assert.equal(called, false, 'the server must not fetch the cover');
      // ...and nothing of ours was written for it.
      assert.equal(fs.readdirSync(store.UPLOAD_DIR).length, 0);
    } finally {
      global.fetch = realFetch;
    }
  });
}

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
    });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.source, {
    provider: 'bgg',
    externalId: '13',
    url: 'https://boardgamegeek.com/boardgame/13/catan',
  });
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

test('PATCH stores an allowlisted imageUrl as a hotlink without downloading it', async () => {
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('must not download a cover'); };
  try {
    const round = await createRound(request);
    const game = (await addGame(round.id)).body;
    const res = await request(app)
      .patch(`/api/rounds/${round.id}/games/${game.id}`)
      .send({ imageUrl: 'https://cf.geekdo-images.com/x/pic.jpg' });
    assert.equal(res.status, 200);
    assert.equal(res.body.image, 'https://cf.geekdo-images.com/x/pic.jpg');
    assert.equal(called, false, 'the server must not fetch the cover');
    assert.equal(fs.readdirSync(store.UPLOAD_DIR).length, 0);
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

// --- Uploaded-file hardening (issue #133): verify real content, derive the
// stored extension from the detected type, reject non-images. ---

// Minimal buffers carrying real magic bytes (padded past the 12-byte sniff min).
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);

test('POST games stores an uploaded PNG and derives the extension from the content', async () => {
  const round = await createRound(request);
  // Filename lies (.jpg) and mimetype is generic — the stored ext must follow
  // the real PNG magic bytes, not the client-supplied name.
  const res = await request(app)
    .post(`/api/rounds/${round.id}/games`)
    .field('title', 'Chess').field('minPlayers', '2').field('maxPlayers', '4')
    .attach('image', PNG_BYTES, { filename: 'cover.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 201);
  assert.match(res.body.image, /^\/uploads\/[0-9a-f]+\.png$/);
  assert.ok(fs.existsSync(path.join(store.UPLOAD_DIR, path.basename(res.body.image))));
});

test('POST games rejects an uploaded file whose content is not a real image', async () => {
  const round = await createRound(request);
  // A spoofed upload: image/* mimetype but the bytes are not an image.
  const before = fs.readdirSync(store.UPLOAD_DIR).length;
  const res = await request(app)
    .post(`/api/rounds/${round.id}/games`)
    .field('title', 'Chess').field('minPlayers', '2').field('maxPlayers', '4')
    .attach('image', Buffer.from('<script>alert(1)</script>'), {
      filename: 'evil.png', contentType: 'image/png',
    });
  assert.equal(res.status, 400);
  // Nothing was written to disk for the rejected upload.
  assert.equal(fs.readdirSync(store.UPLOAD_DIR).length, before);
});

test('PATCH rejects a spoofed image upload and keeps the old cover', async () => {
  const round = await createRound(request);
  const game = (await addGame(round.id)).body;
  // Give it a real cover first.
  const first = await request(app)
    .patch(`/api/rounds/${round.id}/games/${game.id}`)
    .attach('image', JPEG_BYTES, { filename: 'a.jpg', contentType: 'image/jpeg' });
  assert.equal(first.status, 200);
  assert.match(first.body.image, /\.jpg$/);
  const cover = first.body.image;

  const res = await request(app)
    .patch(`/api/rounds/${round.id}/games/${game.id}`)
    .attach('image', Buffer.from('not an image'), {
      filename: 'x.png', contentType: 'image/png',
    });
  assert.equal(res.status, 400);
  // The existing cover is untouched (not cleared, not deleted).
  const detail = await request(app).get(`/api/rounds/${round.id}`);
  assert.equal(detail.body.games.find((g) => g.id === game.id).image, cover);
  assert.ok(fs.existsSync(path.join(store.UPLOAD_DIR, path.basename(cover))));
});
