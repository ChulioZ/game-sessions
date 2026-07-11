'use strict';

// The server serves the SPA shell (public/index.html) for frontend GET
// navigations so deep links and reloads load the app, while /api and real
// static assets keep their own behavior. See lib/app.js and public/js/router.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('./helpers');

test('serves the app shell for a deep frontend path', async () => {
  const res = await request(app).get('/round/abc123/regal');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /html/);
  assert.match(res.text, /id="app"/); // the SPA mount point
});

test('serves the app shell for a game deep link', async () => {
  const res = await request(app).get('/round/abc123/game/def456');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="app"/);
});

test('the bare root still returns the app shell', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="app"/);
});

test('a real static asset is served as itself, not the shell', async () => {
  const res = await request(app).get('/js/router.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.text, /resolveRoute/); // actual router source, not HTML
});

test('an unknown /api path 404s instead of returning the shell', async () => {
  const res = await request(app).get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.text, /id="app"/);
});

test('an unknown /api GET does not leak the HTML shell as JSON either', async () => {
  const res = await request(app).get('/api/rounds/nope/nothing');
  assert.equal(res.status, 404);
});

test('a non-GET request to a frontend path is not served the shell', async () => {
  const res = await request(app).post('/round/abc123');
  assert.equal(res.status, 404);
});
