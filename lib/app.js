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
  app.use('/api/lookup', require('../routes/lookup'));
  app.use('/api/rounds', require('../routes/rounds'));
  app.use('/api/rounds/:rid/games', require('../routes/games'));
  app.use('/api/rounds/:rid/members', require('../routes/members'));
  app.use('/api/rounds/:rid/sessions', require('../routes/sessions'));
  app.use('/api/rounds/:rid/activities', require('../routes/activities'));
  app.use('/api/rounds/:rid/background', require('../routes/background'));
  app.use('/api/rounds/:rid/recommendations', require('../routes/recommendations'));

  // SPA fallback: serve the app shell for frontend GET navigations (deep links,
  // reloads) that aren't an API call, an upload, or a real static file — the
  // client-side router (public/js/router.js) then renders the matching view.
  // Placed last so express.static and the /api routers take precedence; unknown
  // /api/* paths fall through to Express's default 404 rather than the shell.
  app.get(/(.*)/, (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
    if (!req.accepts('html')) return next();
    // Pass the file relative to a `root`, not as an absolute path: res.sendFile
    // rejects (404s) any path segment starting with a dot, and an absolute path
    // includes the whole prefix — so running from a directory like a
    // `.claude/worktrees/…` checkout would otherwise fail. With `root`, only the
    // relative part ('index.html') is checked for dotfiles.
    res.sendFile('index.html', { root: path.join(ROOT, 'public') });
  });

  return app;
}

module.exports = { createApp };
