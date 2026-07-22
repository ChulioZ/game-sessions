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
const repo = require('../lib/repo');

const lastNotice = async () => (await repo.listContactNotices(1))[0];

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

test('every accepted submission is stored as a contact notice (#272)', async () => {
  const res = await request(app).post('/api/contact').send(valid);
  assert.equal(res.status, 200);
  const notice = await lastNotice();
  assert.equal(notice.message, valid.message);
  assert.equal(notice.email, valid.email);
  assert.equal(notice.name, 'Alice');
  assert.equal(notice.subject, 'Hallo');
  // An ordinary message, not a report: category null, undecided, open.
  assert.equal(notice.category, null);
  assert.equal(notice.url, null);
  assert.equal(notice.status, 'open');
  assert.equal(notice.decidedAt, null);
});

test('a report stores the Art. 16(2) fields and acknowledges receipt (Art. 16(4))', async () => {
  process.env.CONTACT_TO = 'ops@example.com';
  const before = outbox.length;
  const res = await request(app).post('/api/contact').send({
    ...valid,
    category: 'copyright',
    url: 'https://spielwirbel.app/uploads/abc123.jpg',
    goodFaith: true,
  });
  assert.equal(res.status, 200);

  const notice = await lastNotice();
  assert.equal(notice.category, 'copyright');
  assert.equal(notice.url, 'https://spielwirbel.app/uploads/abc123.jpg');
  assert.equal(notice.goodFaith, true);

  // Two mails: the operator delivery AND the acknowledgement to the notifier.
  assert.equal(outbox.length, before + 2);
  const [operator, ack] = outbox.slice(-2);
  assert.equal(operator.to, 'ops@example.com');
  assert.match(operator.subject, /Meldung/);
  assert.match(operator.text, /Urheberrecht/);
  assert.match(operator.text, /uploads\/abc123\.jpg/);
  assert.equal(ack.to, 'alice@example.com');
  assert.match(ack.subject, /Eingangsbestätigung/);
  assert.match(ack.text, /Art\. 16/);
  // Replies to the acknowledgement land at the operator mailbox (#307): a reply
  // is plausibly an amendment to the notice.
  assert.equal(ack.replyTo, 'ops@example.com');
});

test('a report can name the reported account by username (#320)', async () => {
  process.env.CONTACT_TO = 'ops@example.com';
  const res = await request(app).post('/api/contact').send({
    ...valid,
    category: 'defamation',
    reportedUsername: 'Anna_91',
    goodFaith: true,
  });
  assert.equal(res.status, 200);

  // Stored as given: it is what the reporter saw, and the panel's lookup folds
  // case itself — normalising here would lose evidence of what was reported.
  const notice = await lastNotice();
  assert.equal(notice.reportedUsername, 'Anna_91');
  assert.match(outbox[outbox.length - 2].text, /Gemeldeter Nutzername: Anna_91/);
});

test('the reported username is optional, capped, and absent rather than empty', async () => {
  // Every key present (null when unset) — the absent-key parity the other
  // notice fields keep, so both backends round-trip a plain message identically.
  await request(app).post('/api/contact').send(valid);
  assert.equal((await lastNotice()).reportedUsername, null);

  // '' folds to absent exactly like `url`, rather than storing a blank string.
  await request(app).post('/api/contact').send({ ...valid, reportedUsername: '   ' });
  assert.equal((await lastNotice()).reportedUsername, null);

  const long = await request(app).post('/api/contact')
    .send({ ...valid, reportedUsername: 'x'.repeat(61) });
  assert.equal(long.status, 400);

  // Deliberately NOT held to the registration policy: a reporter transcribing a
  // handle may miss it slightly, and refusing the notice would lose a report the
  // operator can still act on.
  const loose = await request(app).post('/api/contact')
    .send({ ...valid, reportedUsername: 'anna 91 (maybe?)' });
  assert.equal(loose.status, 200);
});

test('a report without the good-faith statement is rejected (Art. 16(2)(d))', async () => {
  const res = await request(app).post('/api/contact').send({ ...valid, category: 'copyright' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'good_faith_required');
});

test('an unknown category is a 400, never silently demoted to a plain message', async () => {
  const res = await request(app).post('/api/contact').send({ ...valid, category: 'nonsense', goodFaith: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_category');
});

test('a CSAM report may be anonymous (Art. 16(3)); everything else needs an e-mail', async () => {
  const anonymous = { message: 'Report about account X', category: 'csam', goodFaith: true };
  const ok = await request(app).post('/api/contact').send(anonymous);
  assert.equal(ok.status, 200);
  const notice = await lastNotice();
  assert.equal(notice.email, null);
  assert.equal(notice.category, 'csam');
  // No address, no acknowledgement — the operator mail is the only send, with
  // no reply-to (there is nobody to reply to).
  const operator = outbox[outbox.length - 1];
  assert.match(operator.subject, /Meldung/);
  assert.equal(operator.replyTo, undefined);

  const rejected = await request(app).post('/api/contact')
    .send({ message: 'anonymous general mail', category: 'copyright', goodFaith: true });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, 'invalid_email');
  const plain = await request(app).post('/api/contact').send({ message: 'no address at all' });
  assert.equal(plain.status, 400);
});

test('a filled honeypot returns a fake 200, sends nothing and stores nothing', async () => {
  const before = outbox.length;
  const countBefore = await repo.countContactNotices();
  const res = await request(app).post('/api/contact').send({ ...valid, website: 'http://spam.example' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(outbox.length, before, 'nothing was sent');
  assert.equal(await repo.countContactNotices(), countBefore, 'nothing was stored');
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

test('a send failure returns 502 with the fallback email — but keeps the stored notice', async () => {
  process.env.BREVO_API_KEY = 'test-key';
  process.env.MAIL_FROM = 'no-reply@example.com';
  process.env.CONTACT_TO = 'ops@example.com';
  global.fetch = async () => ({ ok: false, status: 500 }); // Brevo error → mail.send rejects
  const countBefore = await repo.countContactNotices();
  const res = await request(app).post('/api/contact').send({ ...valid, message: 'survives the mail outage' });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'contact_unavailable');
  assert.equal(res.body.fallbackEmail, 'ops@example.com');
  // The record is the point of #272: a broken mail setup must not mean there is
  // no evidence the message ever arrived.
  assert.equal(await repo.countContactNotices(), countBefore + 1);
  assert.equal((await lastNotice()).message, 'survives the mail outage');
});
