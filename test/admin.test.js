'use strict';

/*
 * Operator moderation surface end-to-end (issue #268): the ADMIN_PASSWORD gate,
 * the cross-tenant image lookup, takedown, account suspension and the action log.
 *
 * Accounts are enabled here because suspension only has meaning in the public
 * multi-tenant mode — the same setup test/tenant.test.js uses. Mail lands in the
 * in-memory outbox, so there is no network.
 *
 * The gate's OFF state (no ADMIN_PASSWORD -> the whole surface 404s) is asserted
 * on a separate app built with the var unset, mirroring how test/quota.test.js
 * proves its inertness.
 */

process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.ADMIN_PASSWORD = 'operator-secret-pw';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const repo = require('../lib/repo');
const { outbox } = require('../lib/mail');

const PASSWORD = 'correct horse battery';
const ADMIN_PW = 'operator-secret-pw';

async function makeAccount(email) {
  await request(app).post('/api/account/register').send({ email, password: PASSWORD });
  const m = outbox[outbox.length - 1].text.match(/uid=([0-9a-f]+)&token=([A-Za-z0-9_-]+)/);
  await request(app).post('/api/account/verify-email').send({ uid: m[1], token: m[2] });
  const login = await request(app).post('/api/account/login').send({ email, password: PASSWORD });
  assert.equal(login.status, 200);
  const user = await repo.getUserByEmail(email);
  return { token: login.body.accessToken, refreshToken: login.body.refreshToken, user };
}

// Sign in as the operator and return the raw Set-Cookie value for later calls.
async function adminCookie() {
  const res = await request(app).post('/api/admin/login').send({ password: ADMIN_PW });
  assert.equal(res.status, 200);
  return res.headers['set-cookie'];
}

test('the admin gate refuses everything without a valid operator session', async (t) => {
  await t.test('a wrong password does not mint a session', async () => {
    const res = await request(app).post('/api/admin/login').send({ password: 'wrong' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_password');
    assert.equal(res.headers['set-cookie'], undefined);
  });

  await t.test('every gated route 401s unauthenticated', async () => {
    for (const [method, path] of [
      ['get', '/api/admin/me'],
      ['get', '/api/admin/lookup?image=/uploads/a.jpg'],
      ['post', '/api/admin/takedown'],
      ['get', '/api/admin/users'],
      ['get', '/api/admin/log'],
    ]) {
      const res = await request(app)[method](path).send({});
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.error, 'admin_auth_required');
    }
  });

  // The security property the separate secret exists for: an ordinary app
  // session must NOT authenticate the admin surface. lib/auth.js signs "v1.<exp>"
  // while lib/admin.js signs a domain-separated "admin.a1.<exp>" under a
  // different cookie name, so neither token can stand in for the other.
  await t.test('an app session cookie is not an admin session', async () => {
    const auth = require('../lib/auth');
    const appToken = auth.mintToken(auth.sessionSecret());
    const res = await request(app).get('/api/admin/me').set('Cookie', [`aid=${appToken}`]);
    assert.equal(res.status, 401);
  });

  await t.test('a correct password mints an httpOnly session', async () => {
    const res = await request(app).post('/api/admin/login').send({ password: ADMIN_PW });
    assert.equal(res.status, 200);
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /^aid=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    const me = await request(app).get('/api/admin/me').set('Cookie', res.headers['set-cookie']);
    assert.equal(me.status, 200);
  });
});

test('image lookup resolves across tenants and takedown clears the reference', async (t) => {
  const cookie = await adminCookie();
  const owner = await makeAccount('owner@example.com');

  const round = await request(app)
    .post('/api/rounds')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ name: 'Their round', members: ['Zoe'] });
  const rid = round.body.id;

  const game = await request(app)
    .post(`/api/rounds/${rid}/games`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ title: 'Reported Game', minPlayers: 1, maxPlayers: 4 });
  const gid = game.body.id;

  // Set a cover path directly through the repo: the point under test is the
  // lookup, not the upload path (which needs real image bytes).
  await repo.forTenant(owner.user.tenantId).updateGame(rid, gid, { image: '/uploads/reported.jpg' });

  await t.test('a bad path shape is rejected before any lookup', async () => {
    for (const bad of ['../../etc/passwd', '/uploads/../secret', 'reported.jpg', '/other/x.jpg']) {
      const res = await request(app)
        .get(`/api/admin/lookup?image=${encodeURIComponent(bad)}`)
        .set('Cookie', cookie);
      assert.equal(res.status, 400, bad);
    }
  });

  await t.test('an unreferenced image is a 404', async () => {
    const res = await request(app).get('/api/admin/lookup?image=/uploads/nobody.jpg').set('Cookie', cookie);
    assert.equal(res.status, 404);
  });

  await t.test('lookup names the game, round, tenant and account', async () => {
    const res = await request(app).get('/api/admin/lookup?image=/uploads/reported.jpg').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.gameTitle, 'Reported Game');
    assert.equal(res.body.roundName, 'Their round');
    assert.equal(res.body.tenantId, owner.user.tenantId);
    assert.deepEqual(res.body.users.map((u) => u.email), ['owner@example.com']);
  });

  await t.test('takedown requires a reason', async () => {
    const res = await request(app)
      .post('/api/admin/takedown')
      .set('Cookie', cookie)
      .send({ image: '/uploads/reported.jpg' });
    assert.equal(res.status, 400);
  });

  await t.test('takedown clears the reference and logs the action', async () => {
    const res = await request(app)
      .post('/api/admin/takedown')
      .set('Cookie', cookie)
      .send({ image: '/uploads/reported.jpg', reason: 'DSA notice 2026-07-20' });
    assert.equal(res.status, 200);
    assert.equal(res.body.cleared, 1);

    // The owner's own view of the game no longer carries the cover.
    const after = await request(app)
      .get(`/api/rounds/${rid}`)
      .set('Authorization', `Bearer ${owner.token}`);
    assert.equal(after.body.games.find((g) => g.id === gid).image, null);

    // ...and the game itself survives — a takedown removes the image, not data.
    assert.equal(after.body.games.find((g) => g.id === gid).title, 'Reported Game');

    const log = await request(app).get('/api/admin/log').set('Cookie', cookie);
    const entry = log.body.entries[0];
    assert.equal(entry.action, 'takedown');
    assert.equal(entry.reason, 'DSA notice 2026-07-20');
    assert.equal(entry.gameTitle, 'Reported Game');
    assert.equal(entry.tenantId, owner.user.tenantId);
  });

  await t.test('a repeat takedown reports 0 cleared rather than failing', async () => {
    const res = await request(app)
      .post('/api/admin/takedown')
      .set('Cookie', cookie)
      .send({ image: '/uploads/reported.jpg', reason: 'again' });
    assert.equal(res.status, 200);
    assert.equal(res.body.cleared, 0);
  });
});

test('suspending an account blocks it immediately without deleting data', async (t) => {
  const cookie = await adminCookie();
  const victim = await makeAccount('suspend-me@example.com');

  const round = await request(app)
    .post('/api/rounds')
    .set('Authorization', `Bearer ${victim.token}`)
    .send({ name: 'Kept round', members: ['Ann'] });
  assert.equal(round.status, 201);

  await t.test('the user list reports the account as active', async () => {
    const res = await request(app).get('/api/admin/users').set('Cookie', cookie);
    const row = res.body.users.find((u) => u.email === 'suspend-me@example.com');
    assert.equal(row.disabled, false);
    // Secrets must never reach the operator response.
    for (const key of ['identities', 'refreshTokens', 'verification', 'reset']) {
      assert.equal(key in row, false, `${key} must be stripped`);
    }
  });

  await t.test('suspension is recorded and takes effect on the existing token', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${victim.user.id}/disabled`)
      .set('Cookie', cookie)
      .send({ disabled: true, reason: 'Repeated abuse notices' });
    assert.equal(res.status, 200);

    // The access token was already minted and has not expired — suspension must
    // still bite, which is why lib/tenant.js checks rather than only login.
    const api = await request(app).get('/api/rounds').set('Authorization', `Bearer ${victim.token}`);
    assert.equal(api.status, 403);
    assert.equal(api.body.error, 'account_disabled');
  });

  await t.test('login and refresh both refuse a suspended account', async () => {
    const login = await request(app)
      .post('/api/account/login')
      .send({ email: 'suspend-me@example.com', password: PASSWORD });
    assert.equal(login.status, 403);
    assert.equal(login.body.error, 'account_disabled');

    // Suspension also revokes every stored refresh token, so the presented one
    // is already gone by the time the disabled check would run — hence
    // invalid_refresh_token rather than account_disabled. Both refuse; this is
    // the stronger of the two, since the token cannot be reused even if the
    // account is later restored. (routes/account.js keeps the disabled guard as
    // defence in depth, for a row disabled directly in the DB.)
    const refresh = await request(app)
      .post('/api/account/refresh')
      .send({ refreshToken: victim.refreshToken });
    assert.equal(refresh.status, 401);
    assert.equal(refresh.body.error, 'invalid_refresh_token');
  });

  await t.test('the data survives, so evidence is preserved', async () => {
    const rounds = await repo.forTenant(victim.user.tenantId).listRounds();
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].name, 'Kept round');
  });

  await t.test('restoring re-enables access and logs both actions', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${victim.user.id}/disabled`)
      .set('Cookie', cookie)
      .send({ disabled: false, reason: 'Notice withdrawn' });
    assert.equal(res.status, 200);

    const login = await request(app)
      .post('/api/account/login')
      .send({ email: 'suspend-me@example.com', password: PASSWORD });
    assert.equal(login.status, 200);

    const log = await request(app).get('/api/admin/log').set('Cookie', cookie);
    const actions = log.body.entries.map((e) => e.action);
    assert.equal(actions[0], 'user_restored');
    assert.ok(actions.includes('user_disabled'));
  });

  await t.test('an unknown user is a 404', async () => {
    const res = await request(app)
      .post('/api/admin/users/nope/disabled')
      .set('Cookie', cookie)
      .send({ disabled: true, reason: 'x' });
    assert.equal(res.status, 404);
  });
});

test('with no ADMIN_PASSWORD the whole surface 404s', async () => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  try {
    // createApp reads the flag per request, but build a fresh app anyway so the
    // assertion is about a genuinely un-opted-in instance.
    const { createApp } = require('../lib/app');
    const plain = createApp();

    const login = await request(plain).post('/api/admin/login').send({ password: 'anything' });
    assert.equal(login.status, 404);
    assert.equal(login.body.error, 'admin_disabled');

    const me = await request(plain).get('/api/admin/me');
    assert.equal(me.status, 404);

    const users = await request(plain).get('/api/admin/users');
    assert.equal(users.status, 404);
  } finally {
    process.env.ADMIN_PASSWORD = saved;
  }
});
