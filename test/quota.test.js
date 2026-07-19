'use strict';

/*
 * Per-tenant quotas & abuse controls (issue #139).
 *
 * Quotas are enforced ONLY in the public multi-tenant mode (accounts on), so this
 * suite enables accounts and drives real tenants (register → verify → login → token),
 * mirroring test/tenant.test.js. Tiny ceilings are set via env (read per request
 * for the state caps; the recs limiter reads its ceiling at createApp() time, so
 * RECS_TENANT_MONTHLY_MAX is set before ./helpers builds the app) so the caps trip
 * in a couple of requests. The billed Claude call is always stubbed — a real model
 * call must never happen in tests (.claude/rules/no-real-llm-calls-in-tests.md).
 */

// Flags + tiny ceilings BEFORE the app is built (the recs limiter reads its
// ceiling at build time; the state caps read theirs per request).
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.MAX_ROUNDS_PER_TENANT = '2';
process.env.MAX_GAMES_PER_ROUND = '2';
process.env.RECS_TENANT_MONTHLY_MAX = '1';

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

test('per-tenant recommendation-spend cap', async (t) => {
  const realFetch = global.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  t.after(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  });

  // A valid stubbed generation — never the real API.
  const okReply = () => ({
    ok: true, status: 200,
    json: async () => ({
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: JSON.stringify([{ title: 'Splendor', platform: 'analog', reason: 'x' }]) }],
    }),
  });

  const a = await makeAccount('recs-a@example.com');
  const roundA = await request(app).post('/api/rounds').set(auth(a.token))
    .send({ name: 'RecRoundA', members: ['Alice'] });
  const ridA = roundA.body.id;

  await t.test('a failed generation (no key → 503) does NOT consume quota', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    global.fetch = async () => { throw new Error('must not be called'); };
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post(`/api/rounds/${ridA}/recommendations`).set(auth(a.token)).send({});
      assert.equal(res.status, 503);
      assert.equal(res.body.error, 'not_configured');
    }
  });

  await t.test('one successful generation is allowed, the next is 429 quota_recommendations', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = async () => okReply();
    const first = await request(app).post(`/api/rounds/${ridA}/recommendations`).set(auth(a.token)).send({});
    assert.equal(first.status, 200);
    const second = await request(app).post(`/api/rounds/${ridA}/recommendations`).set(auth(a.token)).send({});
    assert.equal(second.status, 429);
    assert.equal(second.body.error, 'quota_recommendations');
  });

  await t.test('reading and deleting runs still works once the quota is spent (only POST is capped)', async () => {
    // Account A's quota is exhausted from the test above. GET the history and
    // DELETE a run must NOT 429 — the guard only caps the billed POST.
    const list = await request(app).get(`/api/rounds/${ridA}/recommendations`).set(auth(a.token));
    assert.equal(list.status, 200);
    assert.ok(list.body.length >= 1);
    const del = await request(app).delete(`/api/rounds/${ridA}/recommendations/${list.body[0].id}`).set(auth(a.token));
    assert.equal(del.status, 200);
  });

  await t.test('the cap is per tenant — another account still gets its one generation', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = async () => okReply();
    const b = await makeAccount('recs-b@example.com');
    const roundB = await request(app).post('/api/rounds').set(auth(b.token))
      .send({ name: 'RecRoundB', members: ['Bob'] });
    const res = await request(app).post(`/api/rounds/${roundB.body.id}/recommendations`).set(auth(b.token)).send({});
    assert.equal(res.status, 200);
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
});
