'use strict';

/*
 * GET /api/config (issues #224/#134, donateUrl since #173): the public,
 * non-sensitive feature flags the static frontend reads to decide whether to
 * render the shared site footer and the support button. Three properties
 * matter:
 *
 *  1. `footer` is all-or-nothing — true only when mail can deliver
 *     (BREVO_API_KEY + MAIL_FROM) AND the Impressum identity is set
 *     (IMPRESSUM_ADDRESS + IMPRESSUM_EMAIL, the same condition that makes the
 *     legal pages exist — lib/legal.js) — so a half-configured instance shows
 *     no public footer rather than a broken one.
 *  2. `donateUrl` is the operator's donation page (#173) — null when
 *     DONATE_URL is unset, which hides the support button entirely.
 *  3. The endpoint must stay reachable without ANY auth in both gate modes:
 *     the footer renders on the login page, before a session or token exists,
 *     and the support button must work for a logged-out visitor too.
 *
 * Env is read per request (like the rate-limit ceilings), so these tests flip
 * process.env around requests against the shared app. The deepEqual assertions
 * pin the WHOLE response shape: nothing else may creep into this public,
 * ungated response — the secret sweep at the bottom is the guard for values.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const { createApp } = require('../lib/app');

const MAIL_ENV = { BREVO_API_KEY: 'test-key', MAIL_FROM: 'no-reply@example.com' };
const OFF = { footer: false, donateUrl: null };

test.afterEach(() => {
  for (const k of ['BREVO_API_KEY', 'MAIL_FROM', 'IMPRESSUM_ADDRESS', 'IMPRESSUM_EMAIL',
    'AUTH_PASSWORD', 'ACCOUNTS_ENABLED', 'SESSION_SECRET', 'ADMIN_PASSWORD',
    'BGG_API_TOKEN', 'DONATE_URL']) {
    delete process.env[k];
  }
});

test('everything is off when nothing is configured', async () => {
  const res = await request(app).get('/api/config');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, OFF);
});

test('mail alone does not enable the footer', async () => {
  Object.assign(process.env, MAIL_ENV);
  const res = await request(app).get('/api/config');
  assert.deepEqual(res.body, OFF);
});

test('the Impressum identity alone does not enable the footer', async () => {
  process.env.IMPRESSUM_ADDRESS = 'Musterweg 1, 12345 Musterstadt';
  process.env.IMPRESSUM_EMAIL = 'kontakt@example.test';
  const res = await request(app).get('/api/config');
  assert.deepEqual(res.body, OFF);
});

test('mail + address without the e-mail stays off (the legal pages would 404)', async () => {
  Object.assign(process.env, MAIL_ENV);
  process.env.IMPRESSUM_ADDRESS = 'Musterweg 1, 12345 Musterstadt';
  const res = await request(app).get('/api/config');
  assert.deepEqual(res.body, OFF);
});

test('a whitespace-only address does not count as set', async () => {
  Object.assign(process.env, MAIL_ENV);
  process.env.IMPRESSUM_ADDRESS = '   ';
  process.env.IMPRESSUM_EMAIL = 'kontakt@example.test';
  const res = await request(app).get('/api/config');
  assert.deepEqual(res.body, OFF);
});

test('mail + full identity enable the footer; env is read per request', async () => {
  Object.assign(process.env, MAIL_ENV);
  process.env.IMPRESSUM_ADDRESS = 'Musterweg 1, 12345 Musterstadt';
  process.env.IMPRESSUM_EMAIL = 'kontakt@example.test';
  const on = await request(app).get('/api/config');
  assert.deepEqual(on.body, { footer: true, donateUrl: null });
  // Same app instance, no rebuild: unsetting one input flips it back off.
  delete process.env.IMPRESSUM_ADDRESS;
  const off = await request(app).get('/api/config');
  assert.deepEqual(off.body, OFF);
});

test('DONATE_URL is echoed as donateUrl, independent of the footer (#173)', async () => {
  process.env.DONATE_URL = 'https://ko-fi.com/spielwirbel';
  const on = await request(app).get('/api/config');
  assert.deepEqual(on.body, { footer: false, donateUrl: 'https://ko-fi.com/spielwirbel' });
  // Read per request: unsetting it hides the button again without a rebuild.
  delete process.env.DONATE_URL;
  const off = await request(app).get('/api/config');
  assert.deepEqual(off.body, OFF);
});

test('a whitespace-only DONATE_URL does not count as set', async () => {
  process.env.DONATE_URL = '   ';
  const res = await request(app).get('/api/config');
  assert.deepEqual(res.body, OFF);
});

test('reachable without a session under the shared-password gate', async () => {
  process.env.AUTH_PASSWORD = 'gate-pw';
  process.env.DONATE_URL = 'https://ko-fi.com/spielwirbel';
  const gatedApp = createApp();
  // Sanity: the data routes ARE gated on this app.
  const gated = await request(gatedApp).get('/api/rounds');
  assert.equal(gated.status, 401);
  const res = await request(gatedApp).get('/api/config');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { footer: false, donateUrl: 'https://ko-fi.com/spielwirbel' });
});

test('reachable without a token in accounts mode', async () => {
  process.env.ACCOUNTS_ENABLED = 'true';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  process.env.DONATE_URL = 'https://ko-fi.com/spielwirbel';
  const accountsApp = createApp();
  const gated = await request(accountsApp).get('/api/rounds');
  assert.equal(gated.status, 401);
  const res = await request(accountsApp).get('/api/config');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { footer: false, donateUrl: 'https://ko-fi.com/spielwirbel' });
});

// The guard that survives future edits (same idea as test/status.test.js):
// plant a recognisable value in every secret-bearing env var and assert none
// of them reaches this public, ungated response in any form. The deepEqual
// shape pins above make this nearly redundant today — this is the tripwire
// for a future field added without one.
test('no secret value ever appears in the response', async () => {
  const secrets = {
    AUTH_PASSWORD: 'SECRETVALUE-auth',
    SESSION_SECRET: 'SECRETVALUE-session',
    ADMIN_PASSWORD: 'SECRETVALUE-admin',
    BREVO_API_KEY: 'SECRETVALUE-brevo',
    BGG_API_TOKEN: 'SECRETVALUE-bgg',
  };
  Object.assign(process.env, secrets);
  const res = await request(app).get('/api/config');
  const serialized = JSON.stringify(res.body);
  for (const [name, value] of Object.entries(secrets)) {
    assert.equal(serialized.includes(value), false, `${name} leaked into /api/config`);
    assert.equal(serialized.includes(value.slice(0, 8)), false, `${name} leaked a prefix`);
  }
});
