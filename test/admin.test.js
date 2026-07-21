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
      ['get', '/api/admin/feedback'],
      // The exports must be no more reachable than the cards they mirror (#288).
      ['get', '/api/admin/log.csv'],
      ['get', '/api/admin/feedback.csv'],
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
    // The image-specific hit is nested under `owner` since #275 — the same
    // response now also answers a round / e-mail / tenant lookup, which have no
    // game or image to report.
    assert.equal(res.body.by, 'image');
    assert.equal(res.body.owner.gameTitle, 'Reported Game');
    assert.equal(res.body.owner.roundName, 'Their round');
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

// Issue #288: both list cards page and export. The property that matters is that
// the CSV holds EVERY entry while the card holds one page — and that a hostile
// feedback message cannot corrupt the file.
test('the list cards page and export the full set', async (t) => {
  const cookie = await adminCookie();

  // Seeded through the repo rather than POST /api/feedback: that route sits
  // behind the app's own gate (accounts are on in this file), and what is under
  // test here is the admin read side, not the submit path.
  //
  // One message carrying every character that breaks a naive CSV writer at once.
  const NASTY = 'Erste Zeile, mit Komma\nzweite mit "Anführungszeichen"\r\nund Umlauten: Grüße';
  assert.equal(await repo.countFeedback(), 0, 'this test assumes it owns the feedback table');
  await repo.createFeedback({
    message: NASTY,
    context: { path: '/round/x', locale: 'de', tenantId: 'tenant-a' },
    createdAt: '2026-07-20T10:00:00.000Z',
  });
  for (let i = 0; i < 4; i += 1) {
    await repo.createFeedback({
      message: `Nachricht ${i}`,
      context: { path: '/', locale: 'de', tenantId: 'tenant-a' },
      createdAt: `2026-07-20T1${i + 1}:00:00.000Z`,
    });
  }

  await t.test('the list route reports a total alongside the page', async () => {
    const res = await request(app).get('/api/admin/feedback?limit=2').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.entries.length, 2);
    assert.equal(res.body.total, 5);
  });

  await t.test('offset walks the whole set exactly once', async () => {
    const seen = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const res = await request(app)
        .get(`/api/admin/feedback?limit=2&offset=${offset}`).set('Cookie', cookie);
      seen.push(...res.body.entries.map((f) => f.message));
    }
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5, 'a page repeated or skipped an entry');
    // Newest first: the four plain messages precede the nasty one, which was
    // submitted first.
    assert.equal(seen[4], NASTY);
  });

  await t.test('the CSV holds every entry, BOM-prefixed and correctly escaped', async () => {
    const res = await request(app).get('/api/admin/feedback.csv').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-type'], /charset=utf-8/);
    assert.match(res.headers['content-disposition'], /attachment; filename="spielwirbel-feedback-\d{4}-\d{2}-\d{2}\.csv"/);

    // The BOM is the very first character, or Excel mis-decodes the umlauts.
    assert.equal(res.text[0], '﻿');
    // Every entry is present, not just the default 100-row page's worth.
    for (let i = 0; i < 4; i += 1) assert.ok(res.text.includes(`Nachricht ${i}`), `missing ${i}`);
    // The nasty message survived intact — quotes doubled, newlines kept inside
    // the field. Counting records is what proves the newline did not end the row.
    assert.ok(res.text.includes('"Anführungszeichen"""') || res.text.includes('""Anführungszeichen""'));
    assert.ok(res.text.includes('Grüße'));

    // Header + 5 records. A broken escaper yields more, because the embedded
    // newlines each start a spurious row.
    assert.equal(countCsvRecords(res.text), 6);
  });

  await t.test('a hostile message cannot become an Excel formula', async () => {
    await repo.createFeedback({
      message: '=cmd|\'/c calc\'!A1',
      context: { path: '/', locale: 'de', tenantId: 'tenant-a' },
      createdAt: '2026-07-20T20:00:00.000Z',
    });
    const res = await request(app).get('/api/admin/feedback.csv').set('Cookie', cookie);
    // Present as text, apostrophe-prefixed — never as a bare leading '='.
    assert.ok(res.text.includes('"\'=cmd|'), 'formula lead was not neutralized');
    assert.ok(!res.text.includes('"=cmd|'), 'a raw formula cell reached the file');
  });

  await t.test('the log export carries the reason and the redacted original', async () => {
    const res = await request(app).get('/api/admin/log.csv').set('Cookie', cookie);
    assert.equal(res.status, 200);
    // 'Vorher' (#275) holds the text a redaction overwrote. It exists nowhere
    // else once the field is blanked, so an export without it is not a
    // complete record of what was removed.
    assert.match(res.text, /"Zeitpunkt","Aktion","Ziel","Spiel","E-Mail","Tenant","Vorher","Begründung"/);
  });
});

// Count top-level CSV records by scanning outside quoted fields, so a newline
// inside a properly quoted value does not count as a record separator.
function countCsvRecords(text) {
  let quoted = false;
  let records = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted && c === '\r' && text[i + 1] === '\n') { records += 1; i += 1; }
  }
  return records;
}

/*
 * #275: the operator panel could only start from a cover path, and could only
 * act on images. These cover the two halves that closes — finding a tenant the
 * way a notice actually names one, and blanking user-authored TEXT.
 */
test('lookup resolves a tenant by round, e-mail or tenant id (#275)', async (t) => {
  const cookie = await adminCookie();
  const owner = await makeAccount('lookup@example.com');
  const auth = (r) => r.set('Authorization', `Bearer ${owner.token}`);

  const round = await auth(request(app).post('/api/rounds'))
    .send({ name: 'Findable', members: ['Zoe', 'Ann'] });
  const rid = round.body.id;
  await auth(request(app).post(`/api/rounds/${rid}/games`))
    .send({ title: 'Catan', minPlayers: 1, maxPlayers: 4 });

  await t.test('exactly one selector is required', async () => {
    for (const query of ['', '?image=/uploads/a.jpg&round=abc', '?round=a&tenant=b']) {
      const res = await request(app).get(`/api/admin/lookup${query}`).set('Cookie', cookie);
      assert.equal(res.status, 400, query || '(none)');
    }
  });

  await t.test('a malformed id is rejected before any lookup', async () => {
    for (const bad of ['../etc', 'a b', 'x/y']) {
      const res = await request(app)
        .get(`/api/admin/lookup?round=${encodeURIComponent(bad)}`).set('Cookie', cookie);
      assert.equal(res.status, 400, bad);
    }
  });

  await t.test('by round id: names the round and summarises the tenant', async () => {
    const res = await request(app).get(`/api/admin/lookup?round=${rid}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.by, 'round');
    assert.equal(res.body.round.roundName, 'Findable');
    assert.equal(res.body.tenantId, owner.user.tenantId);
    // No image was named, so there is no owner to report — the takedown card
    // keys off exactly this.
    assert.equal(res.body.owner, null);

    const row = res.body.summary.rounds.find((r) => r.id === rid);
    assert.equal(row.games, 1);
    assert.equal(row.members, 2);
    assert.equal(res.body.summary.totals.rounds, 1);
  });

  await t.test('by e-mail: the same tenant, found the way a notice names it', async () => {
    const res = await request(app)
      .get('/api/admin/lookup?email=lookup@example.com').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.tenantId, owner.user.tenantId);
    assert.deepEqual(res.body.users.map((u) => u.email), ['lookup@example.com']);
    // Case and padding must not decide whether an abuse report is actionable.
    const loud = await request(app)
      .get('/api/admin/lookup?email=%20LOOKUP%40example.com%20').set('Cookie', cookie);
    assert.equal(loud.status, 200);
    assert.equal(loud.body.tenantId, owner.user.tenantId);
  });

  await t.test('by tenant id: reports the quota ceilings alongside the usage', async () => {
    const res = await request(app)
      .get(`/api/admin/lookup?tenant=${owner.user.tenantId}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    // Accounts are on in this file, so the caps are live (lib/quota.js).
    assert.equal(res.body.quota.enforced, true);
    assert.equal(typeof res.body.quota.roundsPerTenant, 'number');
    assert.equal(typeof res.body.quota.gamesPerRound, 'number');
    assert.equal(typeof res.body.quota.tagsPerRound, 'number');
    // Nothing was uploaded, so there is nothing of ours to size.
    assert.deepEqual(res.body.uploads, {
      count: 0, sized: 0, bytes: 0, complete: true,
    });
  });

  await t.test('unknown selectors are 404s, not empty-but-plausible cards', async () => {
    for (const query of ['round=deadbeef', 'email=nobody@example.com', 'tenant=nosuchtenant']) {
      const res = await request(app).get(`/api/admin/lookup?${query}`).set('Cookie', cookie);
      assert.equal(res.status, 404, query);
    }
  });

  await t.test('content lists the round\'s user-authored text', async () => {
    const res = await request(app).get(`/api/admin/content?round=${rid}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.content.roundName, 'Findable');
    assert.deepEqual(res.body.content.games.map((g) => g.title), ['Catan']);
    assert.deepEqual(res.body.content.members.map((m) => m.name), ['Zoe', 'Ann']);

    const missing = await request(app).get('/api/admin/content?round=deadbeef').set('Cookie', cookie);
    assert.equal(missing.status, 404);
  });
});

test('redaction blanks user text, logs the original and deletes nothing (#275)', async (t) => {
  const cookie = await adminCookie();
  const owner = await makeAccount('redact@example.com');
  const auth = (r) => r.set('Authorization', `Bearer ${owner.token}`);

  const round = await auth(request(app).post('/api/rounds'))
    .send({ name: 'Offensive round name', members: ['Zoe'] });
  const rid = round.body.id;
  const game = await auth(request(app).post(`/api/rounds/${rid}/games`))
    .send({ title: 'Offensive title', minPlayers: 1, maxPlayers: 4 });
  const gid = game.body.id;
  const tag = await auth(request(app).post(`/api/rounds/${rid}/tags`)).send({ name: 'Offensive tag' });

  const redact = (body) => request(app).post('/api/admin/redact').set('Cookie', cookie).send(body);

  await t.test('a reason is mandatory, as on every other logged action', async () => {
    const res = await redact({ kind: 'game', roundId: rid, id: gid });
    assert.equal(res.status, 400);
  });

  await t.test('an unknown kind is refused', async () => {
    assert.equal((await redact({ kind: 'password', roundId: rid, id: gid, reason: 'x' })).status, 400);
  });

  await t.test('the required ids are enforced per kind', async () => {
    // A non-feedback kind needs a round...
    assert.equal((await redact({ kind: 'game', id: gid, reason: 'x' })).status, 400);
    // ...and everything but a round needs a target id.
    assert.equal((await redact({ kind: 'member', roundId: rid, reason: 'x' })).status, 400);
  });

  await t.test('a game title is blanked and the original lands in the log', async () => {
    const res = await redact({
      kind: 'game', roundId: rid, id: gid, reason: 'Notice 2026-07-21, illegal content',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.redacted.previous, 'Offensive title');
    assert.equal(res.body.redacted.replacement, '[entfernt]');

    // The owner's own view shows the redaction...
    const after = await auth(request(app).get(`/api/rounds/${rid}`));
    const g = after.body.games.find((x) => x.id === gid);
    assert.equal(g.title, '[entfernt]');
    // ...and the game itself survives. Redaction blanks text; deleting data is
    // erasure (#273) and stays a separate, harder act.
    assert.equal(g.id, gid);
    assert.equal(after.body.games.length, 1);

    const log = await request(app).get('/api/admin/log').set('Cookie', cookie);
    assert.equal(log.body.entries[0].action, 'redact_game');
    assert.equal(log.body.entries[0].previous, 'Offensive title');
    assert.equal(log.body.entries[0].tenantId, owner.user.tenantId);
  });

  await t.test('a round name redacts with no separate target id', async () => {
    const res = await redact({ kind: 'round', roundId: rid, reason: 'Notice 2026-07-21' });
    assert.equal(res.status, 200);
    assert.equal(res.body.redacted.previous, 'Offensive round name');
    const after = await auth(request(app).get(`/api/rounds/${rid}`));
    assert.equal(after.body.name, '[entfernt]');
  });

  await t.test('a tag keeps its id, so no game loses a tag as a side effect', async () => {
    await auth(request(app).patch(`/api/rounds/${rid}/games/${gid}`)).send({ tagIds: [tag.body.id] });

    const res = await redact({ kind: 'tag', roundId: rid, id: tag.body.id, reason: 'Notice' });
    assert.equal(res.status, 200);
    assert.equal(res.body.redacted.previous, 'Offensive tag');

    const after = await auth(request(app).get(`/api/rounds/${rid}`));
    assert.equal(after.body.tags[0].name, '[entfernt]');
    assert.equal(after.body.tags[0].id, tag.body.id);
    assert.deepEqual(after.body.games.find((x) => x.id === gid).tagIds, [tag.body.id]);
  });

  await t.test('an unknown target is a 404, never a silent success', async () => {
    assert.equal((await redact({ kind: 'game', roundId: rid, id: 'deadbeef', reason: 'x' })).status, 404);
    assert.equal((await redact({ kind: 'round', roundId: 'deadbeef', reason: 'x' })).status, 404);
    assert.equal((await redact({ kind: 'feedback', id: 'deadbeef', reason: 'x' })).status, 404);
  });

  await t.test('feedback text redacts by id alone, leaving the rest of the entry', async () => {
    const posted = await request(app).post('/api/feedback')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ message: 'illegal feedback text' });
    assert.equal(posted.status, 201);

    const before = await request(app).get('/api/admin/feedback').set('Cookie', cookie);
    const entry = before.body.entries[0];
    assert.equal(entry.message, 'illegal feedback text');

    const res = await redact({ kind: 'feedback', id: entry.id, reason: 'Notice' });
    assert.equal(res.status, 200);
    assert.equal(res.body.redacted.previous, 'illegal feedback text');

    const after = await request(app).get('/api/admin/feedback').set('Cookie', cookie);
    assert.equal(after.body.entries[0].message, '[entfernt]');
    // One field, not the row: the context that makes the entry useful survives.
    assert.equal(after.body.entries[0].context.path, entry.context.path);
  });
});

test('the moderation log filters by tenant, action and date (#275)', async (t) => {
  const cookie = await adminCookie();
  const log = (query) => request(app).get(`/api/admin/log?${query}`).set('Cookie', cookie);

  // Seeded straight through the repo: the point under test is the filtering,
  // not the routes that happen to write entries.
  for (const [action, tenantId, at] of [
    ['takedown', 'filt-a', '2026-07-10T09:00:00.000Z'],
    ['redact_game', 'filt-a', '2026-07-11T09:00:00.000Z'],
    ['redact_game', 'filt-b', '2026-07-12T09:00:00.000Z'],
  ]) {
    await repo.logModeration({
      action, target: 'seed', reason: 'seed', at, tenantId,
    });
  }

  await t.test('by tenant, and the total counts the filtered set', async () => {
    const res = await log('tenant=filt-a');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.entries.length, 2);
    assert.ok(res.body.entries.every((e) => e.tenantId === 'filt-a'));
  });

  await t.test('by action, across tenants', async () => {
    // Windowed to the seeds above: earlier tests in this file redact things
    // too, and those entries are stamped with the real clock.
    const res = await log('action=redact_game&from=2026-07-10&to=2026-07-12');
    assert.equal(res.body.total, 2);
    assert.ok(res.body.entries.every((e) => e.action === 'redact_game'));
    // The filter must not have quietly become tenant-scoped.
    assert.deepEqual(res.body.entries.map((e) => e.tenantId), ['filt-b', 'filt-a']);
  });

  await t.test('filters combine as AND', async () => {
    assert.equal((await log('action=redact_game&tenant=filt-b')).body.total, 1);
  });

  await t.test('a bare date bound covers the whole day at BOTH ends', async () => {
    // The trap: to=2026-07-12 compared naively against an ISO timestamp would
    // exclude everything that happened ON the 12th.
    const res = await log('from=2026-07-11&to=2026-07-12');
    assert.deepEqual(res.body.entries.map((e) => e.at), [
      '2026-07-12T09:00:00.000Z', '2026-07-11T09:00:00.000Z',
    ]);
    const oneDay = await log('from=2026-07-12&to=2026-07-12');
    assert.equal(oneDay.body.total, 1);
  });

  await t.test('a malformed date is refused rather than silently ignored', async () => {
    for (const query of ['from=yesterday', 'to=2026-13', 'from=2026-07-11T00:00:00.000Z&to=nope']) {
      const res = await log(query);
      assert.equal(res.status, 400, query);
    }
  });

  await t.test('the CSV export honours the same filters', async () => {
    const res = await request(app).get('/api/admin/log.csv?tenant=filt-a').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('filt-a'));
    // An export that widened back to everything would leak unrelated tenants
    // into a hand-over prepared for one.
    assert.ok(!res.text.includes('filt-b'));

    const bad = await request(app).get('/api/admin/log.csv?from=nope').set('Cookie', cookie);
    assert.equal(bad.status, 400);
  });

  await t.test('the action list offers only values that can match', async () => {
    const res = await request(app).get('/api/admin/log/actions').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.actions.includes('redact_game'));
    assert.deepEqual(res.body.actions, [...new Set(res.body.actions)].sort());
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

    // Including the exports — an un-opted-in instance must not hand out its
    // feedback inbox or action log either (#288).
    for (const path of ['/api/admin/log.csv', '/api/admin/feedback.csv']) {
      const csv = await request(plain).get(path);
      assert.equal(csv.status, 404, path);
    }
  } finally {
    process.env.ADMIN_PASSWORD = saved;
  }
});
