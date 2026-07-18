'use strict';

/*
 * lib/mail.js — both delivery paths, no network ever: the Brevo path runs
 * against a stubbed global fetch (the same boundary-stub pattern as the lookup
 * provider tests), the unconfigured path against the in-memory outbox.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const mail = require('../lib/mail');

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.BREVO_API_KEY;
  delete process.env.MAIL_FROM;
});

test('without BREVO_API_KEY nothing is sent; the message lands in the outbox', async () => {
  global.fetch = async () => { throw new Error('must not fetch'); };
  const before = mail.outbox.length;
  const res = await mail.send({ to: 'a@example.com', subject: 'S', text: 'T' });
  assert.deepEqual(res, { delivered: false });
  assert.equal(mail.outbox.length, before + 1);
  assert.deepEqual(mail.outbox[mail.outbox.length - 1], { to: 'a@example.com', subject: 'S', text: 'T' });
});

test('with BREVO_API_KEY it POSTs the Brevo payload with the key header', async () => {
  process.env.BREVO_API_KEY = 'test-key';
  process.env.MAIL_FROM = 'sender@example.com';
  let captured;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 201 };
  };
  const res = await mail.send({ to: 'b@example.com', subject: 'Betreff', text: 'Inhalt' });
  assert.deepEqual(res, { delivered: true });
  assert.equal(captured.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(captured.opts.headers['api-key'], 'test-key');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.sender.email, 'sender@example.com');
  assert.deepEqual(body.to, [{ email: 'b@example.com' }]);
  assert.equal(body.subject, 'Betreff');
  assert.equal(body.textContent, 'Inhalt');
});

test('a non-ok Brevo response rejects (callers decide whether that is fatal)', async () => {
  process.env.BREVO_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => mail.send({ to: 'c@example.com', subject: 'S', text: 'T' }), /HTTP 401/);
});
