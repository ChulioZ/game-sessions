'use strict';

/*
 * Public contact form (issue #224): POST /api/contact and the standalone
 * /kontakt.html page. No network ever — with BREVO_API_KEY unset lib/mail.js
 * captures messages in its in-memory outbox (the Brevo path, when exercised, is
 * a stubbed global fetch). Covers: happy path + reply-to, the honeypot, input
 * validation, the dedicated rate limit, reachability without auth (both gates),
 * and the fail-loud paths (production-unconfigured, send failure).
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('./helpers');
const { createApp } = require('../lib/app');
const { outbox } = require('../lib/mail');

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  // These are read per request by the route / gates, so a test that sets one
  // must not leak it into the shared app used by later tests.
  for (const k of ['CONTACT_TO', 'BREVO_API_KEY', 'MAIL_FROM', 'NODE_ENV',
    'AUTH_PASSWORD', 'ACCOUNTS_ENABLED', 'SESSION_SECRET']) {
    delete process.env[k];
  }
  // Restore the raised ceilings the shared app was built with (helpers.js).
  process.env.RATE_LIMIT_MAX = '1000000';
  process.env.CONTACT_RATE_LIMIT_MAX = '1000000';
});

const valid = { name: 'Alice', email: 'alice@example.com', subject: 'Hallo', message: 'Bitte anrufen? Nein, schreiben!' };

test('a valid message is delivered to CONTACT_TO with the sender as reply-to', async () => {
  process.env.CONTACT_TO = 'ops@example.com';
  const before = outbox.length;
  const res = await request(app).post('/api/contact').send(valid);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(outbox.length, before + 1);
  const mail = outbox[outbox.length - 1];
  assert.equal(mail.to, 'ops@example.com');
  assert.equal(mail.replyTo, 'alice@example.com');
  assert.match(mail.subject, /Hallo/);
  assert.match(mail.text, /alice@example.com/);
  assert.match(mail.text, /schreiben/);
});

test('a filled honeypot returns a fake 200 and sends nothing', async () => {
  const before = outbox.length;
  const res = await request(app).post('/api/contact').send({ ...valid, website: 'http://spam.example' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(outbox.length, before, 'nothing was sent');
});

test('an invalid email is rejected with 400 invalid_email', async () => {
  const before = outbox.length;
  const res = await request(app).post('/api/contact').send({ ...valid, email: 'not-an-email' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_email');
  assert.equal(outbox.length, before);
});

test('a missing message is rejected with 400', async () => {
  const res = await request(app).post('/api/contact').send({ email: 'a@example.com', message: '   ' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'message_required');
});

test('an oversized message is rejected with 400', async () => {
  const res = await request(app).post('/api/contact').send({ email: 'a@example.com', message: 'x'.repeat(5001) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'message_too_long');
});

test('the contact endpoint has its own low rate limit (429 past the ceiling)', async () => {
  process.env.RATE_LIMIT_MAX = '1000000'; // keep the global limit out of the way
  process.env.CONTACT_RATE_LIMIT_MAX = '2';
  const limited = createApp();
  for (let i = 0; i < 2; i++) {
    const ok = await request(limited).post('/api/contact').send(valid);
    assert.equal(ok.status, 200);
  }
  const blocked = await request(limited).post('/api/contact').send(valid);
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, { error: 'rate_limited' });
});

test('the form and endpoint are reachable without auth when the shared-password gate is on', async () => {
  process.env.AUTH_PASSWORD = 'secret';
  const locked = createApp();
  // Sanity: the gate really is active (a data route is 401 without a session).
  const gated = await request(locked).get('/api/rounds');
  assert.equal(gated.status, 401);
  // The public contact channel stays open.
  const page = await request(locked).get('/kontakt.html');
  assert.equal(page.status, 200);
  assert.match(page.text, /contactForm/);
  const post = await request(locked).post('/api/contact').send(valid);
  assert.equal(post.status, 200);
});

test('the endpoint is reachable without a token in accounts mode', async () => {
  process.env.ACCOUNTS_ENABLED = 'true';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  const accountsApp = createApp();
  // Sanity: /api data routes require a Bearer token in accounts mode.
  const gated = await request(accountsApp).get('/api/rounds');
  assert.equal(gated.status, 401);
  const post = await request(accountsApp).post('/api/contact').send(valid);
  assert.equal(post.status, 200);
});

test('in production with mail unconfigured it fails loud (502) instead of black-holing', async () => {
  process.env.NODE_ENV = 'production';
  process.env.CONTACT_TO = 'ops@example.com';
  // No BREVO_API_KEY / MAIL_FROM → mail.isConfigured() is false.
  const before = outbox.length;
  const res = await request(app).post('/api/contact').send(valid);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'contact_unavailable');
  assert.equal(res.body.fallbackEmail, 'ops@example.com');
  assert.equal(outbox.length, before, 'no fake success into the outbox');
});

test('a send failure returns 502 with the fallback email', async () => {
  process.env.BREVO_API_KEY = 'test-key';
  process.env.MAIL_FROM = 'no-reply@example.com';
  process.env.CONTACT_TO = 'ops@example.com';
  global.fetch = async () => ({ ok: false, status: 500 }); // Brevo error → mail.send rejects
  const res = await request(app).post('/api/contact').send(valid);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'contact_unavailable');
  assert.equal(res.body.fallbackEmail, 'ops@example.com');
});
