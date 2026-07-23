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
  // Provider cover hosts are render-allowed on img-src, mirroring the host
  // allowlist (isAllowedImageUrl) so provider covers show in the add-game/link
  // previews and lookup thumbnails (#179) — and, since #172, so that SAVED
  // covers render at all, since they are hotlinked rather than re-hosted.
  const imgSrc = csp.match(/img-src ([^;]*)/)[1];
  const sources = imageCspSources();
  assert.ok(sources.length > 0, 'there are provider image hosts to allow');
  for (const src of sources) assert.ok(imgSrc.includes(src), `img-src lists ${src}`);
});

// Structural truth-pin for the footer's "no tracking, no ads, no third-party
// scripts" trust claim (#323): scripts, fonts and network connections must all
// be same-origin only. If someone adds a third-party <script>, web font or
// beacon host to the CSP, this fails — so the public claim can't silently drift
// out of true (see .claude/rules/keep-legal-docs-current.md).
test('script-src, font-src and connect-src are self-only (backs the footer trust claim)', async () => {
  const csp = (await request(app).get('/')).headers['content-security-policy'];
  for (const directive of ['script-src', 'font-src', 'connect-src']) {
    const value = csp.match(new RegExp(`${directive} ([^;]*)`))[1].trim();
    assert.equal(value, "'self'", `${directive} must be exactly 'self', got: ${value}`);
  }
});

test('the global rate limit returns 429 once the ceiling is exceeded', async () => {
  process.env.RATE_LIMIT_MAX = '3';
  const limited = createApp();
  for (let i = 0; i < 3; i++) {
    const ok = await request(limited).get('/api/rounds');
    assert.equal(ok.status, 200);
  }
  const blocked = await request(limited).get('/api/rounds');
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, { error: 'rate_limited' });
});
