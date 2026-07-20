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
      ['get', '/api/admin/status'],
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

test('export answers an access request; erasure cascades and is logged (#273)', async (t) => {
  const cookie = await adminCookie();
  const subject = await makeAccount('erase-me@example.com');
  const bystander = await makeAccount('keep-me@example.com');

  const round = await request(app)
    .post('/api/rounds')
    .set('Authorization', `Bearer ${subject.token}`)
    .send({ name: 'Their whole life', members: ['Ann'] });
  const rid = round.body.id;

  const game = await request(app)
    .post(`/api/rounds/${rid}/games`)
    .set('Authorization', `Bearer ${subject.token}`)
    .send({ title: 'A game', minPlayers: 1, maxPlayers: 4 });
  await repo.forTenant(subject.user.tenantId).updateGame(rid, game.body.id, { image: '/uploads/erase1.jpg' });

  // The bystander gets data too, so the cascade is proven not to overreach.
  await request(app)
    .post('/api/rounds')
    .set('Authorization', `Bearer ${bystander.token}`)
    .send({ name: 'Untouched', members: ['Zoe'] });

  await t.test('both new routes are gated like the rest of the surface', async () => {
    for (const path of [`/api/admin/users/${subject.user.id}/export`, `/api/admin/users/${subject.user.id}/erase`]) {
      const res = await request(app).post(path).send({ reason: 'x' });
      assert.equal(res.status, 401, path);
      assert.equal(res.body.error, 'admin_auth_required');
    }
  });

  await t.test('export requires a reason and refuses an unknown account', async () => {
    const noReason = await request(app)
      .post(`/api/admin/users/${subject.user.id}/export`).set('Cookie', cookie).send({});
    assert.equal(noReason.status, 400);

    const unknown = await request(app)
      .post('/api/admin/users/nope/export').set('Cookie', cookie).send({ reason: 'Art. 15' });
    assert.equal(unknown.status, 404);
  });

  await t.test('export returns the account plus its rounds, and never a secret', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${subject.user.id}/export`)
      .set('Cookie', cookie)
      .send({ reason: 'Art. 15 request 2026-07-20' });
    assert.equal(res.status, 200);

    const dump = res.body.export;
    assert.equal(dump.account.email, 'erase-me@example.com');
    assert.equal(dump.tenantId, subject.user.tenantId);
    assert.equal(dump.rounds.length, 1);
    assert.equal(dump.rounds[0].name, 'Their whole life');
    assert.equal(dump.rounds[0].games[0].title, 'A game');
    assert.ok(Array.isArray(dump.rounds[0].activities));

    // The same secret-stripping the account list applies — an export is handed
    // to the data subject, so a password hash in it would be a disclosure.
    for (const key of ['identities', 'refreshTokens', 'verification', 'reset']) {
      assert.equal(key in dump.account, false, `${key} must be stripped`);
    }
    // Another account's round is not in it.
    assert.equal(dump.rounds.some((r) => r.name === 'Untouched'), false);

    const log = await request(app).get('/api/admin/log').set('Cookie', cookie);
    assert.equal(log.body.entries[0].action, 'user_exported');
    assert.equal(log.body.entries[0].reason, 'Art. 15 request 2026-07-20');
  });

  await t.test('erasure refuses without a matching confirmation e-mail', async () => {
    const wrong = await request(app)
      .post(`/api/admin/users/${subject.user.id}/erase`)
      .set('Cookie', cookie)
      .send({ reason: 'Art. 17', confirmEmail: 'someone-else@example.com' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'confirm_mismatch');

    // Nothing happened — the account and its data are still there.
    assert.ok(await repo.getUserById(subject.user.id));
    const missing = await request(app)
      .post(`/api/admin/users/${subject.user.id}/erase`)
      .set('Cookie', cookie)
      .send({ confirmEmail: 'erase-me@example.com' });
    assert.equal(missing.status, 400, 'a reason is mandatory');
  });

  await t.test('erasure removes the account, its rounds and its cover objects', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${subject.user.id}/erase`)
      .set('Cookie', cookie)
      .send({ reason: 'Art. 17 request 2026-07-20', confirmEmail: 'Erase-Me@example.com' });
    assert.equal(res.status, 200);
    assert.equal(res.body.rounds, 1);
    assert.equal(res.body.imagesRemoved, 1);
    assert.equal(res.body.imagesFailed, 0);

    // The identity is gone, so the token no longer resolves to an account…
    assert.equal(await repo.getUserById(subject.user.id), null);

    // SECURITY REGRESSION GUARD (#273): the access token is a stateless JWT with
    // a 15-minute TTL, so this one is still signature-valid. lib/tenant.js used
    // to resolve an unknown uid to `|| DEFAULT_TENANT` — which would hand an
    // erased account's live token the 'default' tenant, i.e. the legacy
    // production group's data, until the token expired. It must be refused.
    const api = await request(app).get('/api/rounds').set('Authorization', `Bearer ${subject.token}`);
    assert.equal(api.status, 401, 'an erased account\'s token must NOT fall back to the default tenant');
    assert.equal(api.body.error, 'auth_required');
    assert.equal(Array.isArray(api.body.rounds), false, 'it must not return any rounds at all');
    // …and login is gone with it.
    const login = await request(app)
      .post('/api/account/login')
      .send({ email: 'erase-me@example.com', password: PASSWORD });
    assert.equal(login.status, 401);

    // The round data went too — this is the half deleteUser alone never did.
    assert.deepEqual(await repo.forTenant(subject.user.tenantId).listRounds(), []);
    assert.equal(await repo.findImageOwner('/uploads/erase1.jpg'), null);

    // The account list no longer shows it.
    const users = await request(app).get('/api/admin/users').set('Cookie', cookie);
    assert.equal(users.body.users.some((u) => u.email === 'erase-me@example.com'), false);
  });

  await t.test('the bystander account and its data are untouched', async () => {
    const rounds = await repo.forTenant(bystander.user.tenantId).listRounds();
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].name, 'Untouched');
    const login = await request(app)
      .post('/api/account/login')
      .send({ email: 'keep-me@example.com', password: PASSWORD });
    assert.equal(login.status, 200);
  });

  await t.test('the log evidences the erasure WITHOUT re-storing the erased data', async () => {
    const log = await request(app).get('/api/admin/log').set('Cookie', cookie);
    const entry = log.body.entries[0];
    assert.equal(entry.action, 'user_erased');
    assert.equal(entry.target, subject.user.id);
    assert.equal(entry.reason, 'Art. 17 request 2026-07-20');
    assert.equal(entry.tenantId, subject.user.tenantId);
    assert.equal(entry.rounds, 1);

    // The record proves the request was honoured; it is not a copy of what was
    // erased. An e-mail address here would survive the erasure it evidences.
    assert.equal('email' in entry, false, 'the erasure log must not keep the address');
    assert.equal(JSON.stringify(entry).includes('erase-me@example.com'), false);
    assert.equal(JSON.stringify(entry).includes('Their whole life'), false);
  });

  await t.test('erasing again is a 404', async () => {
    const res = await request(app)
      .post(`/api/admin/users/${subject.user.id}/erase`)
      .set('Cookie', cookie)
      .send({ reason: 'again', confirmEmail: 'erase-me@example.com' });
    assert.equal(res.status, 404);
  });
});

// The panel's go-live checklist card (#274). The interesting assertions are the
// negative ones: the response must describe THIS process, and must not carry a
// secret. test/status.test.js pins the derivation down field by field; this is
// about the route.
test('the status endpoint reports the running instance without leaking secrets (#274)', async (t) => {
  const cookie = await adminCookie();
  const res = await request(app).get('/api/admin/status').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const { status } = res.body;

  await t.test('it describes the configuration this test process runs with', async () => {
    // This file sets ACCOUNTS_ENABLED + SESSION_SECRET + ADMIN_PASSWORD at the
    // top, and the suite runs on the default backends.
    assert.equal(status.accounts.enabled, true);
    assert.equal(status.accounts.sessionSecretSet, true);
    assert.equal(status.admin.enabled, true);
    assert.equal(status.quotas.enforced, true);
    assert.equal(status.storage.images, 'disk');
    assert.equal(status.storage.data, 'json');
    assert.equal(status.migrations.backend, 'json');
    // Mail is deliberately unconfigured in tests (lib/mail.js's outbox path).
    assert.equal(status.mail.configured, false);
  });

  await t.test('no configured secret is echoed back', async () => {
    const serialized = JSON.stringify(res.body);
    for (const secret of [ADMIN_PW, 'test-session-secret']) {
      assert.equal(serialized.includes(secret), false);
    }
  });

  // Read-only by construction: the card reports configuration, it never edits
  // it — env vars stay a deliberate Railway action. No write verb is routed, so
  // each one falls out of this router unhandled (landing on the /api gate) and
  // must never come back 2xx.
  await t.test('it is read-only — no write verb is offered', async () => {
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const write = await request(app)[method]('/api/admin/status').set('Cookie', cookie).send({});
      assert.ok(write.status >= 400, `${method} /api/admin/status answered ${write.status}`);
    }
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
