'use strict';

/*
 * Per-tenant quotas & abuse controls (issue #139).
 *
 * Quotas are enforced ONLY in the public multi-tenant mode (accounts on), so this
 * suite enables accounts and drives real tenants (register → verify → login → token),
 * mirroring test/tenant.test.js. Tiny ceilings are set via env (read per request)
 * so the caps trip in a couple of requests.
 */

// Flags + tiny ceilings BEFORE the app is built.
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.MAX_ROUNDS_PER_TENANT = '2';
process.env.MAX_GAMES_PER_ROUND = '2';
process.env.MAX_TAGS_PER_ROUND = '2';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const { createApp } = require('../lib/app');
const repo = require('../lib/repo');
const { outbox } = require('../lib/mail');

const PASSWORD = 'correct horse battery';

// Register + verify + login one account; returns its Bearer token and user.
async function makeAccount(email) {
  await request(app).post('/api/account/register').send({ email, password: PASSWORD });
  const m = outbox[outbox.length - 1].text.match(/uid=([0-9a-f]+)&token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'verification mail contains a uid/token link');
  await request(app).post('/api/account/verify-email').send({ uid: m[1], token: m[2] });
  const login = await request(app).post('/api/account/login').send({ email, password: PASSWORD });
  assert.equal(login.status, 200);
  const user = await repo.getUserByEmail(email);
  return { token: login.body.accessToken, user };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

test('rounds-per-tenant cap', async (t) => {
  const a = await makeAccount('rounds-a@example.com');

  await t.test('creates up to the limit, then 403 quota_rounds', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/api/rounds').set(auth(a.token))
        .send({ name: `R${i}`, members: ['Alice'] });
      assert.equal(res.status, 201);
    }
    const over = await request(app).post('/api/rounds').set(auth(a.token))
      .send({ name: 'R3', members: ['Alice'] });
    assert.equal(over.status, 403);
    assert.equal(over.body.error, 'quota_rounds');
    assert.equal(over.body.limit, 2);
  });

  await t.test('deleting a round frees a slot (state cap, not a rate cap)', async () => {
    const list = await request(app).get('/api/rounds').set(auth(a.token));
    await request(app).delete(`/api/rounds/${list.body[0].id}`).set(auth(a.token));
    const res = await request(app).post('/api/rounds').set(auth(a.token))
      .send({ name: 'R-again', members: ['Alice'] });
    assert.equal(res.status, 201);
  });

  await t.test('the cap is per tenant — another account is unaffected', async () => {
    const b = await makeAccount('rounds-b@example.com');
    const res = await request(app).post('/api/rounds').set(auth(b.token))
      .send({ name: 'B1', members: ['Bob'] });
    assert.equal(res.status, 201);
  });
});

test('games-per-round cap', async (t) => {
  const a = await makeAccount('games-a@example.com');
  const round = await request(app).post('/api/rounds').set(auth(a.token))
    .send({ name: 'GameRound', members: ['Alice'] });
  const rid = round.body.id;

  await t.test('adds up to the limit, then 403 quota_games', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post(`/api/rounds/${rid}/games`).set(auth(a.token))
        .field('title', `G${i}`).field('platform', 'analog')
        .field('minPlayers', '1').field('maxPlayers', '4');
      assert.equal(res.status, 201);
    }
    const over = await request(app).post(`/api/rounds/${rid}/games`).set(auth(a.token))
      .field('title', 'G3').field('platform', 'analog')
      .field('minPlayers', '1').field('maxPlayers', '4');
    assert.equal(over.status, 403);
    assert.equal(over.body.error, 'quota_games');
    assert.equal(over.body.limit, 2);
  });
});

// Moving a whole shelf is the one write that can blow past BOTH caps at once,
// and it has to refuse atomically — a half-moved round has no undo.
test('moving all games respects the target round\'s caps (#253)', async (t) => {
  const a = await makeAccount('move-a@example.com');
  const mk = async (name) => (await request(app).post('/api/rounds').set(auth(a.token))
    .send({ name, members: ['Alice'] })).body.id;
  const src = await mk('Source');
  const dst = await mk('Target');

  const addGame = (rid, title) => request(app).post(`/api/rounds/${rid}/games`).set(auth(a.token))
    .field('title', title).field('minPlayers', '1').field('maxPlayers', '4');

  await t.test('refuses over the games cap without moving anything', async () => {
    // MAX_GAMES_PER_ROUND is 2: two in the source, one already in the target.
    await addGame(src, 'S1');
    await addGame(src, 'S2');
    await addGame(dst, 'D1');

    const res = await request(app).post(`/api/rounds/${src}/games/move-to`).set(auth(a.token))
      .send({ targetRoundId: dst });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'quota_games');
    assert.equal(res.body.limit, 2);

    // Atomic: the source still holds both, the target still holds only its own.
    const s = await request(app).get(`/api/rounds/${src}`).set(auth(a.token));
    const d = await request(app).get(`/api/rounds/${dst}`).set(auth(a.token));
    assert.equal(s.body.games.length, 2);
    assert.equal(d.body.games.length, 1);
  });

  // Its own account: MAX_ROUNDS_PER_TENANT is 2, and the pair above already
  // uses both of a's slots.
  await t.test('refuses over the tags cap without creating a tag', async () => {
    const b = await makeAccount('move-b@example.com');
    const mkB = async (name) => (await request(app).post('/api/rounds').set(auth(b.token))
      .send({ name, members: ['Alice'] })).body.id;
    const from = await mkB('From');
    const into = await mkB('Into');

    // MAX_TAGS_PER_ROUND is 2; the source's two tags would both have to be
    // created in the target on top of the two it already has.
    for (const name of ['A', 'B']) {
      await request(app).post(`/api/rounds/${into}/tags`).set(auth(b.token)).send({ name });
    }
    const tags = [];
    for (const name of ['X', 'Y']) {
      tags.push((await request(app).post(`/api/rounds/${from}/tags`).set(auth(b.token)).send({ name })).body.id);
    }
    const game = (await request(app).post(`/api/rounds/${from}/games`).set(auth(b.token))
      .field('title', 'Tagged').field('minPlayers', '1').field('maxPlayers', '4')
      .field('tagIds', tags[0]).field('tagIds', tags[1])).body;
    assert.deepEqual(game.tagIds, tags);

    const res = await request(app).post(`/api/rounds/${from}/games/move-to`).set(auth(b.token))
      .send({ targetRoundId: into });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'quota_tags');
    assert.equal(res.body.limit, 2);

    const d = await request(app).get(`/api/rounds/${into}`).set(auth(b.token));
    assert.equal(d.body.tags.length, 2); // nothing created
    assert.equal(d.body.games.length, 0); // nothing moved
  });
});

test('tags-per-round cap (#238)', async (t) => {
  const a = await makeAccount('tags-a@example.com');
  const round = await request(app).post('/api/rounds').set(auth(a.token))
    .send({ name: 'TagRound', members: ['Alice'] });
  const rid = round.body.id;

  await t.test('creates up to the limit, then 403 quota_tags', async () => {
    for (const name of ['One', 'Two']) {
      const res = await request(app).post(`/api/rounds/${rid}/tags`).set(auth(a.token)).send({ name });
      assert.equal(res.status, 201);
    }
    const over = await request(app).post(`/api/rounds/${rid}/tags`).set(auth(a.token)).send({ name: 'Three' });
    assert.equal(over.status, 403);
    assert.equal(over.body.error, 'quota_tags');
    assert.equal(over.body.limit, 2);
  });

  await t.test('a duplicate name still resolves at the cap (reuses, creates nothing)', async () => {
    const res = await request(app).post(`/api/rounds/${rid}/tags`).set(auth(a.token)).send({ name: 'two' });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Two');
  });

  await t.test('deleting a tag frees the slot (state cap, not a rate cap)', async () => {
    const fetched = await request(app).get(`/api/rounds/${rid}`).set(auth(a.token));
    await request(app).delete(`/api/rounds/${rid}/tags/${fetched.body.tags[0].id}`).set(auth(a.token));
    const res = await request(app).post(`/api/rounds/${rid}/tags`).set(auth(a.token)).send({ name: 'Again' });
    assert.equal(res.status, 201);
  });
});

test('quotas are inert when accounts are off (single-tenant deploy is unchanged)', async (t) => {
  // Build a fresh app with accounts disabled; the gate falls back to the (unset,
  // so no-op) shared password, and quota.enforced() is false. The tiny
  // MAX_ROUNDS_PER_TENANT=2 above must NOT bite here.
  const prev = process.env.ACCOUNTS_ENABLED;
  delete process.env.ACCOUNTS_ENABLED;
  t.after(() => { process.env.ACCOUNTS_ENABLED = prev; });
  const openApp = createApp();

  for (let i = 0; i < 4; i++) {
    const res = await request(openApp).post('/api/rounds')
      .send({ name: `Open${i}`, members: ['Alice'] });
    assert.equal(res.status, 201, `round ${i} should be created with quotas inert`);
  }

  // The tags cap (MAX_TAGS_PER_ROUND=2 above) must be inert too (#238).
  const rounds = await request(openApp).get('/api/rounds');
  const rid = rounds.body[0].id;
  for (let i = 0; i < 4; i++) {
    const res = await request(openApp).post(`/api/rounds/${rid}/tags`).send({ name: `T${i}` });
    assert.equal(res.status, 201, `tag ${i} should be created with quotas inert`);
  }
});
