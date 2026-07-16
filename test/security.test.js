'use strict';

/*
 * Security hardening (issue #130): helmet security headers + rate limiting.
 *
 * Requiring ./helpers sets DATA_DIR and builds the shared `app` (with the
 * limiters raised out of reach) — good for asserting headers. For the 429
 * behaviour we build fresh apps with tiny env limits, so each gets its own
 * in-memory limiter store and the assertions are deterministic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('./helpers');
const { createApp } = require('../lib/app');
const { imageCspSources } = require('../lib/providers');

test('helmet sets security headers on every response', async () => {
  const res = await request(app).get('/');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['x-frame-options'], 'X-Frame-Options is set');
  assert.ok(res.headers['strict-transport-security'], 'HSTS is set');
  const csp = res.headers['content-security-policy'];
  assert.ok(csp, 'Content-Security-Policy is set');
  assert.match(csp, /script-src 'self'/);
  // Inline style attributes and data: images must stay allowed (the views need
  // them), and the local plain-HTTP deployment must not be force-upgraded.
  assert.match(csp, /style-src [^;]*'unsafe-inline'/);
  assert.match(csp, /img-src [^;]*data:/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  // Provider cover hosts are render-allowed on img-src, mirroring the
  // server-side download allowlist (isAllowedImageUrl) so provider covers show
  // in the add-game/link previews and lookup thumbnails — issue #179.
  const imgSrc = csp.match(/img-src ([^;]*)/)[1];
  const sources = imageCspSources();
  assert.ok(sources.length > 0, 'there are provider image hosts to allow');
  for (const src of sources) assert.ok(imgSrc.includes(src), `img-src lists ${src}`);
});

test('the global rate limit returns 429 once the ceiling is exceeded', async () => {
  process.env.RATE_LIMIT_MAX = '3';
  process.env.RECS_RATE_LIMIT_MAX = '1000000';
  const limited = createApp();
  for (let i = 0; i < 3; i++) {
    const ok = await request(limited).get('/api/rounds');
    assert.equal(ok.status, 200);
  }
  const blocked = await request(limited).get('/api/rounds');
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, { error: 'rate_limited' });
});

test('the recommendations endpoint has its own stricter limit', async () => {
  process.env.RATE_LIMIT_MAX = '1000000'; // keep the global limit out of the way
  process.env.RECS_RATE_LIMIT_MAX = '2';
  const limited = createApp();
  // The limiter counts every request before the route runs, so a bogus round
  // (404) still consumes the allowance — no key or stubbed fetch needed.
  for (let i = 0; i < 2; i++) {
    const res = await request(limited).post('/api/rounds/nope/recommendations');
    assert.equal(res.status, 404);
  }
  const blocked = await request(limited).post('/api/rounds/nope/recommendations');
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, { error: 'rate_limited' });

  // A different endpoint is unaffected by the recommendations limiter.
  const other = await request(limited).get('/api/rounds');
  assert.equal(other.status, 200);
});
