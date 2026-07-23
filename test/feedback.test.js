'use strict';

/*
 * Feedback after #321: the dedicated POST /api/feedback route is RETIRED —
 * feedback is now submitted through the public contact form (see
 * test/contact.test.js for the 'feedback' category and its store-only,
 * mail-free, tenant-free behaviour). What remains here is the operator READ
 * side behind the #268 admin gate, plus proof the old route is gone.
 *
 * Feedback is seeded straight through repo.createFeedback (global, un-scoped) —
 * exactly what routes/contact.js now calls — so these tests need no app account.
 */

process.env.ADMIN_PASSWORD = 'operator-secret-pw';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const { createApp } = require('../lib/app');
const repo = require('../lib/repo');

const ADMIN_PW = 'operator-secret-pw';

async function adminCookie() {
  const res = await request(app).post('/api/admin/login').send({ password: ADMIN_PW });
  assert.equal(res.status, 200);
  return res.headers['set-cookie'];
}

test('the dedicated POST /api/feedback route is retired (#321)', async () => {
  // Feedback now goes through the contact form; the standalone submit route is
  // unmounted, so the path matches nothing and 404s. (Legacy mode here — the
  // shared app has accounts off — so the /api gate is a no-op and this reaches
  // the router table, not the auth wall.)
  const res = await request(app).post('/api/feedback').send({ message: 'gone' });
  assert.equal(res.status, 404);
});

test('the operator can read feedback, and only the operator', async (t) => {
  await repo.createFeedback({
    message: 'Readable entry',
    context: { path: '/', locale: 'en', tenantId: null },
    createdAt: new Date().toISOString(),
  });

  await t.test('the list route is behind the admin gate', async () => {
    const res = await request(app).get('/api/admin/feedback');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'admin_auth_required');
  });

  await t.test('lists entries newest first for the operator', async () => {
    const cookie = await adminCookie();
    const res = await request(app).get('/api/admin/feedback').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.entries.length > 0);
    assert.equal(res.body.entries[0].message, 'Readable entry');
  });

  await t.test('a null tenantId (a contact-form submission) is tolerated', async () => {
    // Contact-form feedback carries no tenant (#321); the read side must not choke.
    const cookie = await adminCookie();
    const res = await request(app).get('/api/admin/feedback').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.ok(res.body.entries.every((e) => 'context' in e));
  });

  await t.test('clamps the limit like the log route', async () => {
    await repo.createFeedback({
      message: 'Second entry',
      context: { path: '/', locale: 'en', tenantId: null },
      createdAt: new Date().toISOString(),
    });
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
