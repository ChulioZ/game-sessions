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
