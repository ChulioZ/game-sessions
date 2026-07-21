'use strict';

/*
 * GET /api/config (issues #224/#134): the public, non-sensitive feature flags
 * the static frontend reads to decide whether to render the shared site footer.
 * Two properties matter:
 *
 *  1. `footer` is all-or-nothing — true only when mail can deliver
 *     (BREVO_API_KEY + MAIL_FROM) AND the Impressum identity is set
 *     (IMPRESSUM_ADDRESS + IMPRESSUM_EMAIL, the same condition that makes the
 *     legal pages exist — lib/legal.js) — so a half-configured instance shows
 *     no public footer rather than a broken one.
 *  2. The endpoint must stay reachable without ANY auth in both gate modes:
 *     the footer renders on the login page, before a session or token exists.
 *
 * Env is read per request (like the rate-limit ceilings), so these tests flip
 * process.env around requests against the shared app.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const { createApp } = require('../lib/app');

const MAIL_ENV = { BREVO_API_KEY: 'test-key', MAIL_FROM: 'no-reply@example.com' };

test.afterEach(() => {
  for (const k of ['BREVO_API_KEY', 'MAIL_FROM', 'IMPRESSUM_ADDRESS', 'IMPRESSUM_EMAIL',
    'AUTH_PASSWORD', 'ACCOUNTS_ENABLED', 'SESSION_SECRET']) {
    delete process.env[k];
  }
});

test('footer is off when nothing is configured', async () => {
  const res = await request(app).get('/api/config');
  assert.equal(res.status, 200);
  // deepEqual pins the whole shape: nothing else may creep into this public,
  // ungated response.
  assert.deepEqual(res.body, { footer: false });
});

test('mail alone does not enable the footer', async () => {
  Object.assign(process.env, MAIL_ENV);
  const res = await request(app).get('/api/config');
  assert.deepEqual(res.body, { footer: false });
});

test('the Impressum identity alone does not enable the footer', async () => {
  process.env.IMPRESSUM_ADDRESS = 'Musterweg 1, 12345 Musterstadt';
  process.env.IMPRESSUM_EMAIL = 'kontakt@example.test';
  const res = await request(app).get('/api/config');
  assert.deepEqual(res.body, { footer: false });
});

test('mail + address without the e-mail stays off (the legal pages would 404)', async () => {
  Object.assign(process.env, MAIL_ENV);
  process.env.IMPRESSUM_ADDRESS = 'Musterweg 1, 12345 Musterstadt';
  const res = await request(app).get('/api/config');
  assert.deepEqual(res.body, { footer: false });
});

test('a whitespace-only address does not count as set', async () => {
  Object.assign(process.env, MAIL_ENV);
  process.env.IMPRESSUM_ADDRESS = '   ';
  process.env.IMPRESSUM_EMAIL = 'kontakt@example.test';
  const res = await request(app).get('/api/config');
  assert.deepEqual(res.body, { footer: false });
});

test('mail + full identity enable the footer; env is read per request', async () => {
  Object.assign(process.env, MAIL_ENV);
  process.env.IMPRESSUM_ADDRESS = 'Musterweg 1, 12345 Musterstadt';
  process.env.IMPRESSUM_EMAIL = 'kontakt@example.test';
  const on = await request(app).get('/api/config');
  assert.deepEqual(on.body, { footer: true });
  // Same app instance, no rebuild: unsetting one input flips it back off.
  delete process.env.IMPRESSUM_ADDRESS;
  const off = await request(app).get('/api/config');
  assert.deepEqual(off.body, { footer: false });
});

test('reachable without a session under the shared-password gate', async () => {
  process.env.AUTH_PASSWORD = 'gate-pw';
  const gatedApp = createApp();
  // Sanity: the data routes ARE gated on this app.
  const gated = await request(gatedApp).get('/api/rounds');
  assert.equal(gated.status, 401);
  const res = await request(gatedApp).get('/api/config');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { footer: false });
});

test('reachable without a token in accounts mode', async () => {
  process.env.ACCOUNTS_ENABLED = 'true';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  const accountsApp = createApp();
  const gated = await request(accountsApp).get('/api/rounds');
  assert.equal(gated.status, 401);
  const res = await request(accountsApp).get('/api/config');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { footer: false });
});
