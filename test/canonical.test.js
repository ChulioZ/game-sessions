'use strict';

/*
 * Canonical-host redirect (issue #230): the branded non-canonical domains
 * (spielwirbel.de/.com + www) 301 to spielwirbel.app, while the canonical host,
 * Railway's *.up.railway.app, and — critically — the deploy health-check host
 * are left alone (redirecting the probe would flap every deploy). See
 * lib/canonical.js and .claude/rules/canonical-host-redirect.md.
 *
 * The shared `app` from helpers is built with default env, so the default
 * allowlist/canonical apply. `.redirects(0)` stops superagent from actually
 * following the 301 out to the real spielwirbel.app over the network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('./helpers');
const { createApp } = require('../lib/app');

test('301s a branded non-canonical host to the canonical host, preserving path + query', async () => {
  const res = await request(app).get('/round/abc?x=1').set('Host', 'spielwirbel.de').redirects(0);
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, 'https://spielwirbel.app/round/abc?x=1');
});

test('301s the www variants too, and matches host case-insensitively', async () => {
  const www = await request(app).get('/').set('Host', 'www.spielwirbel.com').redirects(0);
  assert.equal(www.status, 301);
  assert.equal(www.headers.location, 'https://spielwirbel.app/');

  const upper = await request(app).get('/regal').set('Host', 'SPIELWIRBEL.DE').redirects(0);
  assert.equal(upper.status, 301);
  assert.equal(upper.headers.location, 'https://spielwirbel.app/regal');
});

test('the redirect fires ahead of the API auth gate (a branded /api call also 301s)', async () => {
  const res = await request(app).get('/api/rounds').set('Host', 'spielwirbel.com').redirects(0);
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, 'https://spielwirbel.app/api/rounds');
});

test('does NOT redirect the canonical host', async () => {
  const res = await request(app).get('/healthz').set('Host', 'spielwirbel.app').redirects(0);
  assert.equal(res.status, 200);
});

test("does NOT redirect Railway's domain or the deploy health-check host", async () => {
  // Redirecting Host: healthcheck.railway.app would 301 Railway's probe and flap
  // every deploy — this is the whole reason the redirect is an allowlist.
  const health = await request(app).get('/healthz').set('Host', 'healthcheck.railway.app').redirects(0);
  assert.equal(health.status, 200);

  const railway = await request(app).get('/healthz').set('Host', 'spielwirbel-production.up.railway.app').redirects(0);
  assert.equal(railway.status, 200);
});

test('does NOT redirect an ordinary/unlisted host, so the rest of the suite is unaffected', async () => {
  // supertest's default Host is 127.0.0.1 — not on the allowlist.
  const res = await request(app).get('/api/rounds').redirects(0);
  assert.equal(res.status, 200);
});

test('the allowlist and canonical target are env-driven, read per createApp()', async () => {
  const savedCanonical = process.env.CANONICAL_HOST;
  const savedHosts = process.env.REDIRECT_HOSTS;
  try {
    process.env.CANONICAL_HOST = 'example.app';
    process.env.REDIRECT_HOSTS = 'old.example.com';
    const custom = createApp();
    // The configured legacy host redirects to the configured canonical...
    const hit = await request(custom).get('/x').set('Host', 'old.example.com').redirects(0);
    assert.equal(hit.status, 301);
    assert.equal(hit.headers.location, 'https://example.app/x');
    // ...and a host not on the overridden list is left alone.
    const miss = await request(custom).get('/healthz').set('Host', 'spielwirbel.de').redirects(0);
    assert.equal(miss.status, 200);
  } finally {
    if (savedCanonical === undefined) delete process.env.CANONICAL_HOST;
    else process.env.CANONICAL_HOST = savedCanonical;
    if (savedHosts === undefined) delete process.env.REDIRECT_HOSTS;
    else process.env.REDIRECT_HOSTS = savedHosts;
  }
});

test('an empty REDIRECT_HOSTS makes the middleware inert', async () => {
  const saved = process.env.REDIRECT_HOSTS;
  try {
    process.env.REDIRECT_HOSTS = '';
    const inert = createApp();
    const res = await request(inert).get('/healthz').set('Host', 'spielwirbel.de').redirects(0);
    assert.equal(res.status, 200);
  } finally {
    if (saved === undefined) delete process.env.REDIRECT_HOSTS;
    else process.env.REDIRECT_HOSTS = saved;
  }
});
