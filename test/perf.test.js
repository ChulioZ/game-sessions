'use strict';

// Hosted-perf plumbing: gzip compression and static-asset cache headers.
// gzip cuts the round JSON ~8-10x (the API is the hosted latency hot spot);
// the cache headers make content-hashed build assets immutable while keeping
// sw.js always-revalidated so service-worker updates roll out promptly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('./helpers');
const { assetCacheHeaders } = require('../lib/app');

test('compressible responses are gzipped when the client accepts it', async () => {
  // The SPA shell is well over compression's 1 KB threshold.
  const res = await request(app).get('/').set('Accept-Encoding', 'gzip');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
});

test('without Accept-Encoding the response stays uncompressed', async () => {
  const res = await request(app).get('/').set('Accept-Encoding', 'identity');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined);
});

test('sw.js is served no-cache so service-worker updates are picked up', async () => {
  const res = await request(app).get('/sw.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-cache');
});

test('assetCacheHeaders marks content-hashed assets immutable, others default', () => {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  // Hashed build outputs (name.<8-hex>.js/.css, scripts/build.js) → immutable.
  assetCacheHeaders(res, '/srv/dist/js/core.0d868b44.js');
  assert.equal(headers['Cache-Control'], 'public, max-age=31536000, immutable');
  assetCacheHeaders(res, '/srv/dist/styles.8d545bfa.css');
  assert.equal(headers['Cache-Control'], 'public, max-age=31536000, immutable');
  // Un-hashed files get no explicit header (Express's ETag revalidation applies).
  const untouched = {};
  const res2 = { setHeader: (k, v) => { untouched[k] = v; } };
  assetCacheHeaders(res2, '/srv/public/js/core.js');
  assetCacheHeaders(res2, '/srv/public/index.html');
  assert.deepEqual(untouched, {});
});
