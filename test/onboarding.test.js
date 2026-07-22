'use strict';

/*
 * Onboarding / accounts-mode gate (issue #138): when accounts are enabled the app
 * flips from the shared-password gate to per-account tokens. This covers the
 * server-side glue that lets the frontend auth UI work:
 *  - /api data routes require a valid account token (no anonymous 'default').
 *  - /uploads (cover images) accept the token via header OR the lax cookie set on
 *    login, since <img> requests can't send an Authorization header.
 *  - the SPA shell is always served in accounts mode, so the client can render
 *    the login screen (never the standalone shared-password login.html).
 *  - login sets the access cookie, and the verify-email mail links to the in-app
 *    /verify-email landing.
 *
 * No network: BREVO_API_KEY stays unset, so mail lands in the in-memory outbox.
 */

process.env.ACCOUNTS_ENABLED = 'true';
process.env.SESSION_SECRET = 'test-session-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const { outbox } = require('../lib/mail');

const PASSWORD = 'correct horse battery';

// Registration requires a unique app-wide handle (#320). Derived from the address
// so every helper call stays a one-liner and two accounts can never collide.
const handle = (email) => email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '-');

// Register -> verify -> login one account; returns the access token and the raw
// Set-Cookie header from login.
async function makeAccount(email) {
  const reg = await request(app).post('/api/account/register').send({ email, username: handle(email), password: PASSWORD });
  assert.equal(reg.status, 200);
  const mail = outbox[outbox.length - 1].text;
  const m = mail.match(/\/verify-email\?uid=([0-9a-f]+)&token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'verification mail links to the in-app /verify-email landing');
  await request(app).post('/api/account/verify-email').send({ uid: m[1], token: m[2] });
  const login = await request(app).post('/api/account/login').send({ email, password: PASSWORD });
  assert.equal(login.status, 200);
  return { token: login.body.accessToken, setCookie: login.headers['set-cookie'] || [] };
}

test('the verify-email mail links to the in-app landing, not the JSON endpoint', async () => {
  await request(app).post('/api/account/register').send({ email: 'link@example.com', username: 'link', password: PASSWORD });
  const mail = outbox[outbox.length - 1].text;
  assert.match(mail, /\/verify-email\?uid=/);
  assert.doesNotMatch(mail, /\/api\/account\/verify-email\?/);
});

test('login sets the access cookie (so cover <img> GETs authenticate)', async () => {
  const { setCookie } = await makeAccount('cookie@example.com');
  assert.ok(setCookie.some((c) => /^sa=/.test(c)), 'a "sa" access cookie is set');
});

test('accounts mode: /api data routes require a valid token', async () => {
  const { token } = await makeAccount('gate@example.com');

  // No token -> 401 auth_required (the SPA reads this and shows the login screen).
  const anon = await request(app).get('/api/rounds');
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error, 'auth_required');

  // A forged/expired token is refused just the same.
  const forged = await request(app).get('/api/rounds').set('Authorization', 'Bearer not-a-valid-token');
  assert.equal(forged.status, 401);

  // A valid token gets through to the (empty) round list for a brand-new account.
  const ok = await request(app).get('/api/rounds').set('Authorization', `Bearer ${token}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, []);
});

test('accounts mode: the /api Bearer gate ignores the cookie (CSRF-safe)', async () => {
  const { setCookie } = await makeAccount('nocookieapi@example.com');
  const saCookie = setCookie.find((c) => /^sa=/.test(c));
  assert.ok(saCookie);
  // The access cookie alone must NOT authenticate a data route — only the header
  // does — so a cross-site request that could ride the cookie can't reach /api.
  const viaCookie = await request(app).get('/api/rounds').set('Cookie', saCookie.split(';')[0]);
  assert.equal(viaCookie.status, 401);
});

test('accounts mode: /uploads accepts the token via header or cookie, 401 without', async () => {
  const { token, setCookie } = await makeAccount('uploads@example.com');
  const saCookie = setCookie.find((c) => /^sa=/.test(c)).split(';')[0];

  // No credential -> the gate 401s before storage even looks for the file.
  const anon = await request(app).get('/uploads/does-not-exist.png');
  assert.equal(anon.status, 401);

  // A valid Bearer OR the cookie passes the gate; the file is missing, so storage
  // answers 404 (not 401) — proving the gate let the request through.
  const viaHeader = await request(app).get('/uploads/does-not-exist.png').set('Authorization', `Bearer ${token}`);
  assert.equal(viaHeader.status, 404);
  const viaCookie = await request(app).get('/uploads/does-not-exist.png').set('Cookie', saCookie);
  assert.equal(viaCookie.status, 404);
});

test('accounts mode: the SPA shell is served unauthenticated (client renders login)', async () => {
  // A logged-out visitor gets the app shell (not the shared-password login.html),
  // because the auth UI lives in the SPA; the data routes above stay token-gated.
  const res = await request(app).get('/round/some-id/regal').set('Accept', 'text/html');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="app"/);
  assert.doesNotMatch(res.text, /id="loginForm"/); // not the standalone shared-password page
});
