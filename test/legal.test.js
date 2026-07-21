'use strict';

/*
 * Legal pages (issue #134): /impressum + /datenschutz are server-rendered from
 * the IMPRESSUM_ADDRESS / IMPRESSUM_EMAIL env identity and must
 *
 *  1. answer 404 while EITHER var is unset (no placeholder Impressum, ever),
 *  2. render both documents (DE authoritative + EN courtesy) once configured,
 *  3. escape the env values (they are interpolated into HTML),
 *  4. stay reachable without any auth (a legal notice must be public), and
 *  5. never link the shut-down EU ODR platform (Reg. (EU) 2024/3228) or cite
 *     the repealed § 5 TMG — the stale-boilerplate traps #134 documents.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app } = require('./helpers');
const { createApp } = require('../lib/app');
const legal = require('../lib/legal');

const IDENTITY = {
  IMPRESSUM_ADDRESS: 'Musterweg 1\\nc/o Empfangsservice\\n12345 Musterstadt',
  IMPRESSUM_EMAIL: 'kontakt@example.test',
};

test.afterEach(() => {
  for (const k of ['IMPRESSUM_ADDRESS', 'IMPRESSUM_EMAIL', 'AUTH_PASSWORD']) delete process.env[k];
});

test('both routes 404 while the identity is not configured', async () => {
  for (const path of ['/impressum', '/datenschutz']) {
    const res = await request(app).get(path);
    assert.equal(res.status, 404, `${path} must 404 unconfigured`);
    assert.ok(!res.text.includes('<html'), 'no shell/app markup on the 404');
  }
});

test('one var alone is not enough — no partial Impressum', async () => {
  process.env.IMPRESSUM_ADDRESS = IDENTITY.IMPRESSUM_ADDRESS;
  assert.equal((await request(app).get('/impressum')).status, 404);
  delete process.env.IMPRESSUM_ADDRESS;
  process.env.IMPRESSUM_EMAIL = IDENTITY.IMPRESSUM_EMAIL;
  assert.equal((await request(app).get('/impressum')).status, 404);
});

test('configured: the Impressum renders identity, both languages, § 5 DDG', async () => {
  Object.assign(process.env, IDENTITY);
  const res = await request(app).get('/impressum');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.ok(res.text.includes(legal.OPERATOR_NAME), 'operator name present');
  // The \n escapes in the env value become line breaks.
  assert.ok(res.text.includes('Musterweg 1<br>c/o Empfangsservice<br>12345 Musterstadt'));
  assert.ok(res.text.includes('kontakt@example.test'));
  assert.ok(res.text.includes('§ 5 DDG'), 'cites the DDG');
  assert.ok(!/§\s*5\s*TMG/.test(res.text), 'never the repealed TMG');
  assert.ok(res.text.includes('Courtesy translation'), 'EN section present');
  assert.ok(res.text.includes('/kontakt.html'), 'links the second contact channel');
});

test('configured: the privacy policy covers the real processors and no ODR link', async () => {
  Object.assign(process.env, IDENTITY);
  const res = await request(app).get('/datenschutz');
  assert.equal(res.status, 200);
  for (const marker of [
    'Railway', 'Cloudflare', 'Brevo',            // the three processors
    'Wikidata',                                  // BGG search recipient (adversarial pass)
    'geekdo-images.com', 'steamstatic.com',      // hotlinked cover hosts disclosed (#172)
    'Nutzungsereignisse',                        // product-event logging (#261) disclosed
    'Mandanten-Kennung',                         // feedback stores the tenant id — no false anonymity
    'Aktionsprotokoll',                          // moderation log + erasure-record retention
    '§ 25', 'TDDDG',                             // consent-free storage position
    'Art. 77',                                   // right to lodge a complaint
    'Art. 22',                                   // explicit no-automated-decisions statement
    legal.OPERATOR_NAME,
  ]) {
    assert.ok(res.text.includes(marker), `policy must mention ${marker}`);
  }
  assert.ok(!res.text.includes('ec.europa.eu/consumers/odr'), 'no link to the shut-down ODR platform');
  assert.ok(!res.text.includes('TTDSG'), 'uses the current TDDDG name');
});

test('env values are escaped before interpolation', async () => {
  process.env.IMPRESSUM_ADDRESS = 'Weg 1 <script>alert(1)</script>';
  process.env.IMPRESSUM_EMAIL = 'a"b@example.test';
  const res = await request(app).get('/impressum');
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes('<script>alert'), 'address is escaped');
  assert.ok(res.text.includes('&lt;script&gt;'), 'escaped form present');
  assert.ok(!res.text.includes('"a"b@'), 'email quotes escaped in attributes');
});

test('reachable without a session under the shared-password gate', async () => {
  Object.assign(process.env, IDENTITY);
  process.env.AUTH_PASSWORD = 'gate-pw';
  const gatedApp = createApp();
  assert.equal((await request(gatedApp).get('/api/rounds')).status, 401);
  assert.equal((await request(gatedApp).get('/impressum')).status, 200);
  assert.equal((await request(gatedApp).get('/datenschutz')).status, 200);
});

test('renderAddress: trims, drops blank lines, handles real newlines', () => {
  assert.equal(legal.renderAddress('A 1\n\n  B 2  \nC 3'), 'A 1<br>B 2<br>C 3');
  assert.equal(legal.renderAddress('A 1\\nB 2'), 'A 1<br>B 2');
  assert.equal(legal.renderAddress('x & <y>'), 'x &amp; &lt;y&gt;');
});
