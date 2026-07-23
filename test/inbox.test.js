'use strict';

/*
 * The per-user in-app inbox HTTP surface (issue #207): GET /api/account/inbox,
 * POST /api/account/inbox/:id/read, DELETE /api/account/inbox/:id.
 *
 * Accounts must be ON for the account router to serve (it 404s
 * `accounts_disabled` otherwise, like every /api/account route), so this suite
 * enables accounts and drives real accounts (register → verify → login → token),
 * mirroring test/quota.test.js. There is no producer route yet — invitations
 * (#207) and friend requests (#325) arrive in later slices — so items are seeded
 * through the repo, then the read/mark/dismiss routes are exercised over HTTP,
 * including that one account can never touch another's items.
 */

// Flags BEFORE the app is built.
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

test('GET /api/account/inbox requires a token', async () => {
  const res = await request(app).get('/api/account/inbox');
  assert.equal(res.status, 401);
});

test('inbox: list, mark-read and dismiss over HTTP', async () => {
  const a = await makeAccount('inbox-a@example.com');
  const one = await repo.addInboxItem(a.user.id, { type: 'round_invitation', payload: { roundName: 'Spieleabend' } });
  const two = await repo.addInboxItem(a.user.id, { type: 'friend_request', payload: { from: 'bob' } });

  const list = await request(app).get('/api/account/inbox').set(auth(a.token));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map((i) => i.id), [two.id, one.id]); // newest first
  assert.equal(list.body.items[1].payload.roundName, 'Spieleabend');
  assert.equal(list.body.items[1].read, false);

  const read = await request(app).post(`/api/account/inbox/${one.id}/read`).set(auth(a.token));
  assert.equal(read.status, 200);
  assert.equal(read.body.item.read, true);
  const afterRead = await request(app).get('/api/account/inbox').set(auth(a.token));
  assert.equal(afterRead.body.items.find((i) => i.id === one.id).read, true);

  const del = await request(app).delete(`/api/account/inbox/${one.id}`).set(auth(a.token));
  assert.equal(del.status, 204);
  const afterDel = await request(app).get('/api/account/inbox').set(auth(a.token));
  assert.equal(afterDel.body.items.some((i) => i.id === one.id), false);

  // A missing/already-gone item is a 404 on both mutating routes.
  assert.equal((await request(app).post(`/api/account/inbox/${one.id}/read`).set(auth(a.token))).status, 404);
  assert.equal((await request(app).delete(`/api/account/inbox/${one.id}`).set(auth(a.token))).status, 404);
});

test('inbox: one account can never read, mark or dismiss another account\'s items', async () => {
  const a = await makeAccount('inbox-owner@example.com');
  const b = await makeAccount('inbox-other@example.com');
  const mine = await repo.addInboxItem(a.user.id, { type: 'round_invitation', payload: {} });

  // B's list never contains A's item.
  const bList = await request(app).get('/api/account/inbox').set(auth(b.token));
  assert.equal(bList.body.items.some((i) => i.id === mine.id), false);

  // B mutating A's item is indistinguishable from not-found (404), and leaves it untouched.
  assert.equal((await request(app).post(`/api/account/inbox/${mine.id}/read`).set(auth(b.token))).status, 404);
  assert.equal((await request(app).delete(`/api/account/inbox/${mine.id}`).set(auth(b.token))).status, 404);
  const aList = await request(app).get('/api/account/inbox').set(auth(a.token));
  assert.equal(aList.body.items.find((i) => i.id === mine.id).read, false);
});
