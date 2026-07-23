'use strict';

/*
 * Grant-based round access — the resolver (issue #207).
 *
 * resolveRoundGrant (lib/tenant.js) re-scopes a request to a round's OWNER tenant
 * when the caller holds a grant on that round, so a grantee acts AS the owner
 * tenant (RLS un-widened). This suite proves the isolation the whole feature
 * rests on: a grantee reaches EXACTLY the granted round — read and write — and
 * nothing else in the owner's tenant, cannot delete the owner's round, and a
 * non-grantee is refused.
 *
 * Accounts must be ON for per-user tenants + grants to exist, so this enables
 * accounts and drives real accounts (register → verify → login), mirroring
 * test/quota.test.js. There is no route to CREATE a grant yet (invitation accept
 * is a later slice of #207), so grants are seeded through the repo.
 */

process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'test-session-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const repo = require('../lib/repo');
const { outbox } = require('../lib/mail');

const PASSWORD = 'correct horse battery';
const handle = (email) => email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '-');
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function makeAccount(email) {
  await request(app).post('/api/account/register').send({ email, username: handle(email), password: PASSWORD });
  const m = outbox[outbox.length - 1].text.match(/uid=([0-9a-f]+)&token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'verification mail contains a uid/token link');
  await request(app).post('/api/account/verify-email').send({ uid: m[1], token: m[2] });
  const login = await request(app).post('/api/account/login').send({ email, password: PASSWORD });
  assert.equal(login.status, 200);
  return { token: login.body.accessToken, user: await repo.getUserByEmail(email) };
}

test('a grantee reaches exactly the granted round — read, write, no delete, no other rounds', async () => {
  const owner = await makeAccount('grant-owner@example.com');
  const grantee = await makeAccount('grant-grantee@example.com');
  const outsider = await makeAccount('grant-outsider@example.com');

  // Owner creates a shared round (with a game) and a SEPARATE private round.
  const shared = (await request(app).post('/api/rounds').set(auth(owner.token))
    .send({ name: 'Freitagsrunde', members: ['Owner'] })).body;
  await request(app).post(`/api/rounds/${shared.id}/games`).set(auth(owner.token))
    .send({ title: 'Catan', minPlayers: 2, maxPlayers: 4 });
  const private_ = (await request(app).post('/api/rounds').set(auth(owner.token))
    .send({ name: 'Privatrunde', members: ['Owner'] })).body;

  // Seed the grant: the grantee may act on `shared`, owned by the owner's tenant.
  await repo.createGrant({ roundId: shared.id, ownerTenantId: owner.user.tenantId, userId: grantee.user.id });

  // READ: the grantee sees the owner's shared round and its game.
  const read = await request(app).get(`/api/rounds/${shared.id}`).set(auth(grantee.token));
  assert.equal(read.status, 200);
  assert.equal(read.body.name, 'Freitagsrunde');
  assert.deepEqual(read.body.games.map((g) => g.title), ['Catan']);

  // WRITE: the grantee adds a game, and it lands in the OWNER's round (the owner sees it).
  const add = await request(app).post(`/api/rounds/${shared.id}/games`).set(auth(grantee.token))
    .send({ title: 'Azul', minPlayers: 2, maxPlayers: 4 });
  assert.equal(add.status, 201);
  const ownerView = await request(app).get(`/api/rounds/${shared.id}`).set(auth(owner.token));
  assert.deepEqual(ownerView.body.games.map((g) => g.title).sort(), ['Azul', 'Catan']);

  // NO OTHER ROUNDS: the owner's private round is invisible to the grantee (no grant on it).
  assert.equal((await request(app).get(`/api/rounds/${private_.id}`).set(auth(grantee.token))).status, 404);

  // NO DELETE: a grant does not authorize destroying the owner's round.
  const del = await request(app).delete(`/api/rounds/${shared.id}`).set(auth(grantee.token));
  assert.equal(del.status, 403);
  assert.equal(del.body.error, 'not_owner');
  assert.equal((await request(app).get(`/api/rounds/${shared.id}`).set(auth(owner.token))).status, 200); // still there

  // HOME LIST is own-tenant only (home-merge is a later slice): the shared round
  // is NOT in the grantee's round list — proof the re-scope is per-:rid, not leaking into the list.
  const list = await request(app).get('/api/rounds').set(auth(grantee.token));
  assert.equal(list.body.some((r) => r.id === shared.id), false);

  // A NON-grantee cannot reach the round at all.
  assert.equal((await request(app).get(`/api/rounds/${shared.id}`).set(auth(outsider.token))).status, 404);
});

test('the owner is unaffected: they read, edit and delete their own round normally', async () => {
  const owner = await makeAccount('grant-owner2@example.com');
  const grantee = await makeAccount('grant-grantee2@example.com');

  const round = (await request(app).post('/api/rounds').set(auth(owner.token))
    .send({ name: 'Sonntagsrunde', members: ['Owner'] })).body;
  await repo.createGrant({ roundId: round.id, ownerTenantId: owner.user.tenantId, userId: grantee.user.id });

  // The grant on this round must not change how the OWNER experiences it.
  assert.equal((await request(app).get(`/api/rounds/${round.id}`).set(auth(owner.token))).status, 200);
  const del = await request(app).delete(`/api/rounds/${round.id}`).set(auth(owner.token));
  assert.equal(del.status, 200); // owner delete succeeds (200 { ok: true })
  assert.equal(del.body.ok, true);
  assert.equal((await request(app).get(`/api/rounds/${round.id}`).set(auth(owner.token))).status, 404); // gone
});
