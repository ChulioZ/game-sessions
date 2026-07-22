'use strict';

/*
 * Tenancy end-to-end (issue #136): the tenant middleware (lib/tenant.js)
 * resolves every /api data request to a tenant and hands the routes a scoped
 * repo — so two accounts can never see each other's rounds. Since #138 flipped
 * the app to accounts, an accounts-on instance requires a valid token (no
 * anonymous 'default' access); with accounts DISABLED the gate-only caller (no
 * Bearer token — today's production shape) still resolves to the 'default'
 * tenant with unchanged behaviour. Uses the JSON backend via the shared test
 * app; the same isolation is contract-tested on both backends in
 * test/support/repo-contract.js, and Postgres RLS in test/repo.postgres.test.js.
 *
 * No network: mail lands in the in-memory outbox (see test/account.test.js).
 */

// Enable accounts BEFORE the app is built (flags are read per request, but
// being explicit keeps the setup obvious).
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'test-session-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const repo = require('../lib/repo');
const { outbox } = require('../lib/mail');

const PASSWORD = 'correct horse battery';

// Registration requires a unique app-wide handle (#320). Derived from the address
// so every helper call stays a one-liner and two accounts can never collide.
const handle = (email) => email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '-');

// Register + verify + login one account; returns its Bearer token and user.
async function makeAccount(email) {
  await request(app).post('/api/account/register').send({ email, username: handle(email), password: PASSWORD });
  const m = outbox[outbox.length - 1].text.match(/uid=([0-9a-f]+)&token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'verification mail contains a uid/token link');
  await request(app).post('/api/account/verify-email').send({ uid: m[1], token: m[2] });
  const login = await request(app).post('/api/account/login').send({ email, password: PASSWORD });
  assert.equal(login.status, 200);
  const user = await repo.getUserByEmail(email);
  return { token: login.body.accessToken, user };
}

test('tenant isolation across accounts and the default (gate-only) caller', async (t) => {
  const a = await makeAccount('tenant-a@example.com');
  const b = await makeAccount('tenant-b@example.com');
  let roundId;

  await t.test('each new account is its own tenant', () => {
    assert.match(a.user.tenantId, /^[0-9a-f]{16}$/);
    assert.match(b.user.tenantId, /^[0-9a-f]{16}$/);
    assert.notEqual(a.user.tenantId, b.user.tenantId);
  });

  await t.test('a round created with account A lands in A\'s tenant', async () => {
    const res = await request(app)
      .post('/api/rounds')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'A-Runde', members: ['Alice'] });
    assert.equal(res.status, 201);
    roundId = res.body.id;

    const mine = await request(app).get(`/api/rounds/${roundId}`).set('Authorization', `Bearer ${a.token}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.name, 'A-Runde');
  });

  await t.test('account B sees neither the round nor its list entry', async () => {
    const detail = await request(app).get(`/api/rounds/${roundId}`).set('Authorization', `Bearer ${b.token}`);
    assert.equal(detail.status, 404);
    const list = await request(app).get('/api/rounds').set('Authorization', `Bearer ${b.token}`);
    assert.ok(!list.body.some((r) => r.id === roundId));
  });

  await t.test('account B cannot mutate it either', async () => {
    const del = await request(app).delete(`/api/rounds/${roundId}`).set('Authorization', `Bearer ${b.token}`);
    assert.equal(del.status, 404);
    const game = await request(app)
      .post(`/api/rounds/${roundId}/games`)
      .set('Authorization', `Bearer ${b.token}`)
      .send({ title: 'Evil', type: 'analog' });
    assert.equal(game.status, 404);
  });

  await t.test('in accounts mode an unauthenticated or forged request is refused (#138)', async () => {
    // #138 flipped the gate: with accounts on there is no anonymous 'default'
    // access — a missing or invalid token is 401 (auth_required), not a silent
    // fall-through to the 'default' tenant. (When accounts are DISABLED the
    // gate-only 'default' caller still works — see the second test below.)
    const anon = await request(app).get(`/api/rounds/${roundId}`);
    assert.equal(anon.status, 401);
    const forged = await request(app).get(`/api/rounds/${roundId}`).set('Authorization', 'Bearer not-a-valid-token');
    assert.equal(forged.status, 401);
    // Creating a round without a token is refused too — no unauthenticated writes.
    const created = await request(app).post('/api/rounds').send({ name: 'Default-Runde', members: ['M'] });
    assert.equal(created.status, 401);
  });

  await t.test('the round is still fully there for account A', async () => {
    const res = await request(app).get(`/api/rounds/${roundId}`).set('Authorization', `Bearer ${a.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.members.length, 1);
  });
});

test('with accounts disabled every caller is the default tenant', async () => {
  const flag = process.env.ACCOUNTS_ENABLED;
  delete process.env.ACCOUNTS_ENABLED;
  try {
    const created = await request(app).post('/api/rounds').send({ name: 'Gate-Runde', members: ['M'] });
    assert.equal(created.status, 201);
    // Even a (now inert) Bearer token resolves to 'default'.
    const res = await request(app).get(`/api/rounds/${created.body.id}`).set('Authorization', 'Bearer whatever');
    assert.equal(res.status, 200);
  } finally {
    process.env.ACCOUNTS_ENABLED = flag;
  }
});
