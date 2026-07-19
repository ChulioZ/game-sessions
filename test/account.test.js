'use strict';

/*
 * User accounts (issue #135): register -> verify -> login -> refresh -> reset,
 * plus the feature flag, anti-enumeration behaviour, and member linking.
 * No network: BREVO_API_KEY stays unset, so lib/mail.js captures every message
 * in its in-memory outbox and the tests read tokens out of the mail text —
 * exactly the delivery-degraded path a self-hoster without email runs.
 */

// The account feature is env-gated; enable it BEFORE the app is built (the
// flags are read per request, but being explicit keeps the setup obvious).
process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'test-session-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const repo = require('../lib/repo');
const accounts = require('../lib/accounts');
const { outbox } = require('../lib/mail');

const EMAIL = 'user@example.com';
const PASSWORD = 'correct horse battery';

// Pull the uid/token pair out of the latest captured mail.
function lastMailTokens() {
  const text = outbox[outbox.length - 1].text;
  const m = text.match(/uid=([0-9a-f]+)&token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'mail contains a uid/token link');
  return { uid: m[1], token: m[2] };
}

/* ------------------------------ feature flag -------------------------------- */

test('the whole surface 404s while accounts are not enabled', async () => {
  const flag = process.env.ACCOUNTS_ENABLED;
  delete process.env.ACCOUNTS_ENABLED;
  try {
    for (const path of ['/api/account/register', '/api/account/login']) {
      const res = await request(app).post(path).send({ email: EMAIL, password: PASSWORD });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'accounts_disabled');
    }
  } finally {
    process.env.ACCOUNTS_ENABLED = flag;
  }
});

test('enabling accounts without a SESSION_SECRET keeps them off (forgeable tokens)', async () => {
  const secret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = '';
  try {
    const res = await request(app).post('/api/account/login').send({ email: EMAIL, password: PASSWORD });
    assert.equal(res.status, 404);
  } finally {
    process.env.SESSION_SECRET = secret;
  }
});

/* ------------------------------- validation --------------------------------- */

test('register validates email shape and password length', async () => {
  const bad = await request(app).post('/api/account/register').send({ email: 'not-an-email', password: PASSWORD });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_email');

  const short = await request(app).post('/api/account/register').send({ email: EMAIL, password: 'short' });
  assert.equal(short.status, 400);
  assert.equal(short.body.error, 'invalid_password');
});

/* ------------------------- register -> verify -> login ---------------------- */

test('full account lifecycle', async (t) => {
  let verifyUid, verifyToken, tokens;

  await t.test('register creates the user and mails a verification link', async () => {
    const res = await request(app).post('/api/account/register').send({ email: EMAIL.toUpperCase(), password: PASSWORD });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });

    ({ uid: verifyUid, token: verifyToken } = lastMailTokens());
    const user = await repo.getUserByEmail(EMAIL); // stored lowercased
    assert.equal(user.id, verifyUid);
    assert.equal(user.emailVerified, false);
    // Only hashes at rest — never the raw password or token.
    assert.ok(!JSON.stringify(user).includes(PASSWORD));
    assert.ok(!JSON.stringify(user).includes(verifyToken));
  });

  await t.test('re-registering the same email answers identically and sends nothing', async () => {
    const before = outbox.length;
    const res = await request(app).post('/api/account/register').send({ email: EMAIL, password: 'other password 1' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true }); // indistinguishable from a fresh signup
    assert.equal(outbox.length, before);
  });

  await t.test('login before verification is refused', async () => {
    const res = await request(app).post('/api/account/login').send({ email: EMAIL, password: PASSWORD });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'email_not_verified');
  });

  await t.test('verify-email rejects a wrong token, accepts the mailed one once', async () => {
    const bad = await request(app).get(`/api/account/verify-email?uid=${verifyUid}&token=wrong`);
    assert.equal(bad.status, 400);

    const ok = await request(app).get(`/api/account/verify-email?uid=${verifyUid}&token=${verifyToken}`);
    assert.equal(ok.status, 200);

    const again = await request(app).get(`/api/account/verify-email?uid=${verifyUid}&token=${verifyToken}`);
    assert.equal(again.status, 400); // single-use
  });

  await t.test('login returns an access/refresh pair; wrong password stays a generic 401', async () => {
    const wrong = await request(app).post('/api/account/login').send({ email: EMAIL, password: 'wrong password' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, 'invalid_credentials');
    const unknown = await request(app).post('/api/account/login').send({ email: 'ghost@example.com', password: PASSWORD });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error, 'invalid_credentials'); // same error: no enumeration

    const res = await request(app).post('/api/account/login').send({ email: EMAIL, password: PASSWORD });
    assert.equal(res.status, 200);
    assert.ok(res.body.accessToken && res.body.refreshToken);
    assert.equal(res.body.user.email, EMAIL);
    tokens = res.body;
  });

  await t.test('/me works with the access token, 401s without', async () => {
    const res = await request(app).get('/api/account/me').set('Authorization', `Bearer ${tokens.accessToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.email, EMAIL);
    assert.equal(res.body.emailVerified, true);

    assert.equal((await request(app).get('/api/account/me')).status, 401);
    assert.equal((await request(app).get('/api/account/me').set('Authorization', 'Bearer garbage')).status, 401);
  });

  await t.test('refresh rotates the token: the old one is spent, the new one works', async () => {
    const first = await request(app).post('/api/account/refresh').send({ refreshToken: tokens.refreshToken });
    assert.equal(first.status, 200);
    assert.ok(first.body.accessToken && first.body.refreshToken);
    assert.notEqual(first.body.refreshToken, tokens.refreshToken);

    const replay = await request(app).post('/api/account/refresh').send({ refreshToken: tokens.refreshToken });
    assert.equal(replay.status, 401); // rotation spent it

    tokens = { ...tokens, refreshToken: first.body.refreshToken };
  });

  await t.test('refresh rejects malformed and forged tokens', async () => {
    for (const bad of ['garbage', 'r1.someuser.token', null]) {
      const res = await request(app).post('/api/account/refresh').send({ refreshToken: bad });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'invalid_refresh_token');
    }
  });

  await t.test('logout revokes the refresh token', async () => {
    const res = await request(app).post('/api/account/logout').send({ refreshToken: tokens.refreshToken });
    assert.equal(res.status, 200);
    const after = await request(app).post('/api/account/refresh').send({ refreshToken: tokens.refreshToken });
    assert.equal(after.status, 401);
  });

  await t.test('password reset: forgot mails a link, reset swaps the hash and revokes sessions', async () => {
    // A live session that the reset must revoke.
    const login = await request(app).post('/api/account/login').send({ email: EMAIL, password: PASSWORD });
    const preResetRefresh = login.body.refreshToken;

    const before = outbox.length;
    const ghost = await request(app).post('/api/account/forgot-password').send({ email: 'ghost@example.com' });
    assert.equal(ghost.status, 200); // identical answer, no mail
    assert.equal(outbox.length, before);

    const res = await request(app).post('/api/account/forgot-password').send({ email: EMAIL });
    assert.equal(res.status, 200);
    const { uid, token } = lastMailTokens();

    const badToken = await request(app).post('/api/account/reset-password')
      .send({ uid, token: 'wrong', password: 'brand new password' });
    assert.equal(badToken.status, 400);

    const ok = await request(app).post('/api/account/reset-password')
      .send({ uid, token, password: 'brand new password' });
    assert.equal(ok.status, 200);

    const replay = await request(app).post('/api/account/reset-password')
      .send({ uid, token, password: 'another password 9' });
    assert.equal(replay.status, 400); // single-use

    const oldPw = await request(app).post('/api/account/login').send({ email: EMAIL, password: PASSWORD });
    assert.equal(oldPw.status, 401);
    const newPw = await request(app).post('/api/account/login').send({ email: EMAIL, password: 'brand new password' });
    assert.equal(newPw.status, 200);

    const revoked = await request(app).post('/api/account/refresh').send({ refreshToken: preResetRefresh });
    assert.equal(revoked.status, 401); // reset revoked every session
  });

  await t.test('an expired verification token is refused', async () => {
    await request(app).post('/api/account/register').send({ email: 'late@example.com', password: PASSWORD });
    const { uid, token } = lastMailTokens();
    const user = await repo.getUserById(uid);
    await repo.updateUser(uid, {
      verification: { ...user.verification, expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    const res = await request(app).get(`/api/account/verify-email?uid=${uid}&token=${token}`);
    assert.equal(res.status, 400);
  });
});

/* ------------------------------ member linking ------------------------------ */

test('a member can be linked to a user and unlinked again', async () => {
  // Accounts are on in this file (#138 gate), so the round is created and edited
  // with an account's Bearer token, and the member is linked to that account.
  const email = 'linkme@example.com';
  await request(app).post('/api/account/register').send({ email, password: PASSWORD });
  const { uid, token: vtok } = lastMailTokens();
  await request(app).post('/api/account/verify-email').send({ uid, token: vtok });
  const login = await request(app).post('/api/account/login').send({ email, password: PASSWORD });
  const bearer = `Bearer ${login.body.accessToken}`;
  const user = await repo.getUserByEmail(email);

  const created = await request(app)
    .post('/api/rounds').set('Authorization', bearer)
    .send({ name: 'Test round', members: ['Alice', 'Bob'] });
  const round = created.body;
  const mid = round.members[0].id;

  const bogus = await request(app).patch(`/api/rounds/${round.id}/members/${mid}`).set('Authorization', bearer).send({ userId: 'nope' });
  assert.equal(bogus.status, 400);

  const linked = await request(app).patch(`/api/rounds/${round.id}/members/${mid}`).set('Authorization', bearer).send({ userId: user.id });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.userId, user.id);

  const unlinked = await request(app).patch(`/api/rounds/${round.id}/members/${mid}`).set('Authorization', bearer).send({ userId: null });
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.userId, null);
});

/* --------------------------- token primitive edges -------------------------- */

test('access tokens are JWTs that reject tampering, wrong signature, and expiry', () => {
  const good = accounts.mintAccessToken('user1');
  assert.equal(accounts.verifyAccessToken(good), 'user1');

  const parts = good.split('.');
  assert.equal(parts.length, 3); // a real JWT: header.payload.signature
  const [header, payload, sig] = parts;

  // Swap the payload for one with a different sub while keeping the original
  // signature — the signature covers header+payload, so verification must fail.
  const forged = Buffer.from(JSON.stringify({ sub: 'other' })).toString('base64url');
  assert.equal(accounts.verifyAccessToken(`${header}.${forged}.${sig}`), null);

  assert.equal(accounts.verifyAccessToken(`${header}.${payload}.deadbeef`), null); // bad signature
  assert.equal(accounts.verifyAccessToken('garbage'), null); // not a JWT
  assert.equal(accounts.verifyAccessToken(accounts.mintAccessToken('user1', -1000)), null); // expired
});

test('access tokens are signed with SESSION_SECRET only — no AUTH_PASSWORD fallback', () => {
  const token = accounts.mintAccessToken('user1');

  // A different SESSION_SECRET must not verify the token...
  const realSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'a-completely-different-secret';
  try {
    assert.equal(accounts.verifyAccessToken(token), null);
  } finally {
    process.env.SESSION_SECRET = realSecret;
  }

  // ...and AUTH_PASSWORD is never consulted as a signing key: with SESSION_SECRET
  // cleared, verification fails even when AUTH_PASSWORD equals the old secret.
  process.env.SESSION_SECRET = '';
  process.env.AUTH_PASSWORD = realSecret;
  try {
    assert.equal(accounts.verifyAccessToken(token), null);
  } finally {
    process.env.SESSION_SECRET = realSecret;
    delete process.env.AUTH_PASSWORD;
  }
});

test('pushRefreshToken drops expired entries and caps the list at the oldest end', () => {
  const future = new Date(Date.now() + 1e6).toISOString();
  const expired = { tokenHash: 'old', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z' };
  const list = [expired];
  for (let i = 0; i < accounts.MAX_REFRESH_TOKENS + 3; i++) {
    list.push({ tokenHash: `t${i}`, createdAt: new Date(2026, 0, i + 1).toISOString(), expiresAt: future });
  }
  const next = accounts.pushRefreshToken(list, { tokenHash: 'newest', createdAt: new Date(2026, 6, 1).toISOString(), expiresAt: future });
  assert.equal(next.length, accounts.MAX_REFRESH_TOKENS);
  assert.ok(!next.some((t) => t.tokenHash === 'old')); // expired dropped
  assert.ok(!next.some((t) => t.tokenHash === 't0')); // oldest evicted
  assert.equal(next[next.length - 1].tokenHash, 'newest');
});
