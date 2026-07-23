'use strict';

/*
 * Shared test setup. Points DATA_DIR at a fresh temp folder *before* the store
 * is required — the store reads data.json once at require-time and keeps it in
 * memory, so the override has to happen first. node --test runs each test file
 * in its own process, so every file gets an isolated, empty dataset.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'game-sessions-test-'));
process.env.DATA_DIR = DATA_DIR;

// The shared app must never trip the rate limiters during the ordinary suite —
// raise both ceilings out of reach here (createApp reads them at call time).
// The limiters' real behaviour is covered by test/security.test.js, which builds
// its own app with tiny limits.
process.env.RATE_LIMIT_MAX = '1000000';
process.env.AUTH_RATE_LIMIT_MAX = '1000000';
// Same reasoning for the contact-form limiter (#224), whose default is 5/window
// and covers feedback too since #321 (the separate feedback route is retired).
process.env.CONTACT_RATE_LIMIT_MAX = '1000000';

// Keep the observability request logger quiet during the ordinary suite so test
// output isn't buried under one JSON line per request. test/observability.test.js
// drives LOG_LEVEL itself to assert the logger's real behaviour.
process.env.LOG_LEVEL = 'silent';

const { createApp } = require('../lib/app');
const store = require('../lib/store');

const app = createApp();

// Create a round directly through the API and return its full object.
async function createRound(request, over = {}) {
  const res = await request(app)
    .post('/api/rounds')
    .send({ name: 'Test round', members: ['Alice', 'Bob'], ...over });
  return res.body;
}

module.exports = { app, store, DATA_DIR, createRound };
