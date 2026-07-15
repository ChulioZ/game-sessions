'use strict';

// PWA plumbing (issue #142): the web manifest, the service worker, and the
// registration script must be served as real static files (not swallowed by the
// SPA fallback), the manifest must be valid, and every asset the service worker
// precaches must actually resolve — otherwise `cache.addAll(SHELL)` rejects and
// the SW never installs. See public/manifest.webmanifest and public/sw.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { app } = require('./helpers');

test('serves the web manifest as JSON, not the HTML shell', async () => {
  const res = await request(app).get('/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /json/);
  assert.doesNotMatch(res.text, /id="app"/); // not the SPA shell
});

test('the manifest declares the fields browsers need to install', async () => {
  const res = await request(app).get('/manifest.webmanifest');
  const m = JSON.parse(res.text);
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  assert.ok(m.name, 'name is required');
  assert.ok(m.theme_color, 'theme_color is required');
  assert.ok(m.background_color, 'background_color is required');
  // At least a 192 and a 512 icon (the install-criteria sizes).
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), 'needs a 192 icon');
  assert.ok(sizes.includes('512x512'), 'needs a 512 icon');
});

test('serves the service worker as JavaScript, not the HTML shell', async () => {
  const res = await request(app).get('/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.text, /addEventListener\('fetch'/); // the real SW source
});

test('the service worker never caches live data routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  // Guard against a regression that would cache API responses or gated covers.
  assert.match(src, /'\/api\/'/);
  assert.match(src, /'\/uploads\/'/);
});

test('serves the SW registration script', async () => {
  const res = await request(app).get('/js/pwa.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.text, /serviceWorker\.register\('\/sw\.js'\)/);
});

test('index.html wires up the manifest, theme-color, icons and registration', async () => {
  const res = await request(app).get('/');
  assert.match(res.text, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(res.text, /<meta name="theme-color"/);
  assert.match(res.text, /rel="apple-touch-icon"/);
  assert.match(res.text, /src="\/js\/pwa\.js"/);
});

test('every asset the service worker precaches is actually served', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const block = src.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'could not find the SHELL precache list in sw.js');
  const shell = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(shell.length > 5, 'SHELL should list the app shell assets');
  for (const url of shell) {
    const res = await request(app).get(url);
    assert.equal(res.status, 200, `precached asset ${url} must be served (got ${res.status})`);
  }
});

test('the PWA icons are served as PNGs', async () => {
  for (const url of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png']) {
    const res = await request(app).get(url);
    assert.equal(res.status, 200, `${url} should be served`);
    assert.match(res.headers['content-type'], /image\/png/);
  }
});
