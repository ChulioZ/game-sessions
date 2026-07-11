'use strict';

/*
 * Builds the Express app: middleware + route mounting only. No listening here,
 * so tests can require the app and drive it (e.g. via supertest) without opening
 * a port. server.js requires this and calls listen().
 */

const express = require('express');
const path = require('path');

const { ROOT, UPLOAD_DIR } = require('./store');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/uploads', express.static(UPLOAD_DIR));

  // API routes (split by resource).
  app.use('/api/rounds', require('../routes/rounds'));
  app.use('/api/rounds/:rid/games', require('../routes/games'));
  app.use('/api/rounds/:rid/members', require('../routes/members'));
  app.use('/api/rounds/:rid/sessions', require('../routes/sessions'));
  app.use('/api/rounds/:rid/activities', require('../routes/activities'));
  app.use('/api/rounds/:rid/background', require('../routes/background'));

  return app;
}

module.exports = { createApp };
