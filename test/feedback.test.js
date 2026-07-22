'use strict';

/*
 * In-app user feedback end-to-end (issue #260): the POST write side, the
 * honeypot, the anonymous-by-default identity rule, and the operator read side
 * behind the #268 admin gate.
 *
 * Accounts are enabled here because the identity opt-in only has meaning in the
 * public multi-tenant mode — the same setup test/admin.test.js and
 * test/tenant.test.js use. Legacy (shared-password) mode is asserted separately
 * at the bottom on an app built with accounts off, mirroring how
 * test/quota.test.js proves its inertness.
 */

process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.ADMIN_PASSWORD = 'operator-secret-pw';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const { createApp } = require('../lib/app');
const repo = require('../lib/repo');
const { outbox } = require('../lib/mail');

const PASSWORD = 'correct horse battery';

// Registration requires a unique app-wide handle (#320). Derived from the address
// so every helper call stays a one-liner and two accounts can never collide.
const handle = (email) => email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '-');

const ADMIN_PW = 'operator-secret-pw';

async function makeAccount(email) {
  await request(app).post('/api/account/register').send({ email, username: handle(email), password: PASSWORD });
  const m = outbox[outbox.length - 1].text.match(/uid=([0-9a-f]+)&token=([A-Za-z0-9_-]+)/);
  await request(app).post('/api/account/verify-email').send({ uid: m[1], token: m[2] });
  const login = await request(app).post('/api/account/login').send({ email, password: PASSWORD });
  assert.equal(login.status, 200);
  return { token: login.body.accessToken, user: await repo.getUserByEmail(email) };
}

async function adminCookie() {
  const res = await request(app).post('/api/admin/login').send({ password: ADMIN_PW });
  assert.equal(res.status, 200);
  return res.headers['set-cookie'];
}

// The stored entry for a message, read straight from the repo so the assertions
// are about what was PERSISTED, not about what the read route chose to show.
async function stored(message) {
  const entries = await repo.listFeedback(500);
  return entries.find((e) => e.message === message);
}

test('submitting feedback', async (t) => {
  const { token, user } = await makeAccount('feedback-writer@example.com');
  const auth = (req) => req.set('Authorization', `Bearer ${token}`);

  await t.test('stores the message with its context', async () => {
    const res = await auth(request(app).post('/api/feedback')).send({
      message: 'The Regal filter is confusing',
      path: '/round/abc/regal',
      locale: 'de',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.id);

    const entry = await stored('The Regal filter is confusing');
    assert.ok(entry);
    assert.equal(entry.context.path, '/round/abc/regal');
    assert.equal(entry.context.locale, 'de');
    assert.equal(entry.context.tenantId, user.tenantId);
    assert.ok(entry.createdAt);
  });

  await t.test('is anonymous unless identity is opted in', async () => {
    const res = await auth(request(app).post('/api/feedback'))
      .send({ message: 'Anonymous by default' });
    assert.equal(res.status, 201);

    const entry = await stored('Anonymous by default');
    // The whole point of the opt-in: an ordinary submission records no address
    // and no user id, even though the request itself was authenticated.
    assert.equal(entry.context.email, undefined);
    assert.equal(entry.context.userId, undefined);
  });

  await t.test('attaches the account when opted in', async () => {
    const res = await auth(request(app).post('/api/feedback'))
      .send({ message: 'Please reply to me', attachIdentity: true });
    assert.equal(res.status, 201);

    const entry = await stored('Please reply to me');
    assert.equal(entry.context.email, 'feedback-writer@example.com');
    assert.equal(entry.context.userId, user.id);
  });

  await t.test('never takes the identity from the request body', async () => {
    // A caller opting in cannot choose WHOSE identity gets attached: the server
    // re-derives it from the Bearer token and ignores anything supplied here.
    const res = await auth(request(app).post('/api/feedback')).send({
      message: 'Spoof attempt',
      attachIdentity: true,
      context: { email: 'victim@example.com', tenantId: 'someone-else' },
      email: 'victim@example.com',
      userId: 'not-my-id',
    });
    assert.equal(res.status, 201);

    const entry = await stored('Spoof attempt');
    assert.equal(entry.context.email, 'feedback-writer@example.com');
    assert.equal(entry.context.userId, user.id);
    assert.equal(entry.context.tenantId, user.tenantId);
  });

  await t.test('rejects an empty message', async () => {
    const res = await auth(request(app).post('/api/feedback')).send({ message: '   ' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'A message is required');
  });

  await t.test('rejects an over-long message', async () => {
    const res = await auth(request(app).post('/api/feedback'))
      .send({ message: 'x'.repeat(2001) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Message is too long');
  });

  await t.test('drops an unknown locale but still keeps the message', async () => {
    // Deliberately lenient, matching routes/lookup.js's lookupLang: the message
    // is the valuable part, so a metadata field it can't parse must never cost
    // the submission.
    const res = await auth(request(app).post('/api/feedback'))
      .send({ message: 'Odd locale', locale: 'fr' });
    assert.equal(res.status, 201);

    const entry = await stored('Odd locale');
    assert.ok(entry);
    assert.equal(entry.context.locale, null);
  });

  await t.test('a filled honeypot looks accepted but stores nothing', async () => {
    const res = await auth(request(app).post('/api/feedback'))
      .send({ message: 'I am a bot', website: 'http://spam.example' });
    // A normal-looking 201 on purpose — reporting the rejection would tell a bot
    // exactly which field gave it away.
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.equal(await stored('I am a bot'), undefined);
  });

  await t.test('requires an authenticated caller in accounts mode', async () => {
    const res = await request(app).post('/api/feedback').send({ message: 'No token' });
    assert.equal(res.status, 401);
    assert.equal(await stored('No token'), undefined);
  });
});

test('the operator can read feedback, and only the operator', async (t) => {
  const { token } = await makeAccount('feedback-reader@example.com');
  await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${token}`)
    .send({ message: 'Readable entry', path: '/', locale: 'en' });

  await t.test('the list route is behind the admin gate', async () => {
    const res = await request(app).get('/api/admin/feedback');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'admin_auth_required');
  });

  await t.test('an ordinary account token does not open it', async () => {
    // The panel's ADMIN_PASSWORD is a separate credential from any app session —
    // an app token must not be usable here (.claude/rules/admin-moderation-surface.md).
    const res = await request(app).get('/api/admin/feedback')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
  });

  await t.test('lists entries newest first for the operator', async () => {
    const cookie = await adminCookie();
    const res = await request(app).get('/api/admin/feedback').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.entries.length > 0);
    assert.equal(res.body.entries[0].message, 'Readable entry');
  });

  await t.test('clamps the limit like the log route', async () => {
    const cookie = await adminCookie();
    const res = await request(app).get('/api/admin/feedback?limit=1').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.entries.length, 1);
  });
});

test('the surface 404s entirely when ADMIN_PASSWORD is unset', async (t) => {
  const prev = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  t.after(() => { process.env.ADMIN_PASSWORD = prev; });
  const closedApp = createApp();

  const res = await request(closedApp).get('/api/admin/feedback');
  assert.equal(res.status, 404);
});

test('feedback works in legacy shared-password mode', async (t) => {
  const prev = process.env.ACCOUNTS_ENABLED;
  delete process.env.ACCOUNTS_ENABLED;
  t.after(() => { process.env.ACCOUNTS_ENABLED = prev; });
  const legacyApp = createApp();

  const res = await request(legacyApp).post('/api/feedback')
    // Opting in with no account to attach must still succeed — it just has
    // nothing to record, which is what makes the button safe to show in both modes.
    .send({ message: 'Legacy mode works', attachIdentity: true });
  assert.equal(res.status, 201);

  const entry = await stored('Legacy mode works');
  assert.ok(entry);
  assert.equal(entry.context.tenantId, 'default');
  assert.equal(entry.context.email, undefined);
});

test('the feedback limiter refuses a flood', async (t) => {
  const prev = process.env.FEEDBACK_RATE_LIMIT_MAX;
  const prevAccounts = process.env.ACCOUNTS_ENABLED;
  process.env.FEEDBACK_RATE_LIMIT_MAX = '3';
  // Accounts must stay off for the whole test, not just createApp(): the gate is
  // resolved per REQUEST (accounts.accountsEnabled() reads env in the middleware),
  // so restoring it early would 401 every call below instead of exercising the
  // limiter.
  delete process.env.ACCOUNTS_ENABLED;
  t.after(() => {
    process.env.FEEDBACK_RATE_LIMIT_MAX = prev;
    process.env.ACCOUNTS_ENABLED = prevAccounts;
  });
  // A throwaway app so the tiny ceiling can't leak into the shared one — the
  // limiter store is per-app-instance (.claude/rules/security-middleware.md).
  const limitedApp = createApp();

  for (let i = 0; i < 3; i += 1) {
    const ok = await request(limitedApp).post('/api/feedback').send({ message: `flood ${i}` });
    assert.equal(ok.status, 201);
  }
  const blocked = await request(limitedApp).post('/api/feedback').send({ message: 'one too many' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
});
