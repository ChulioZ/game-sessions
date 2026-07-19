'use strict';

/*
 * Spielwirbel – small local server.
 *
 * Persistence: the default is a single file data/data.json (see lib/store.js);
 * set DATABASE_URL to use PostgreSQL instead (see lib/repo/, issue #127).
 * Images: files under data/uploads/ by default, or S3-compatible object storage
 * when S3_BUCKET is set (see lib/storage/, issue #128); only the path is persisted.
 *
 * Start:  npm start   ->  http://localhost:3000
 *
 * Note: auth is optional and off by default – the MVP runs on a local home
 *       network only. Set AUTH_PASSWORD to gate the app behind a single shared
 *       login (issue #129, see lib/auth.js); a full account model is the roadmap.
 *       Local-only/open is the current stage, not a permanent stance.
 */

const { DATA_FILE, UPLOAD_DIR } = require('./lib/store');
const { createApp } = require('./lib/app');
const repo = require('./lib/repo');

const imagesLocation = process.env.S3_BUCKET
  ? `S3 object storage (bucket ${process.env.S3_BUCKET})`
  : UPLOAD_DIR;

const app = createApp();
const PORT = process.env.PORT || 3000;

// Prepare the data backend before serving (Postgres ensures its schema here;
// the JSON backend's init() is a no-op), then listen.
repo.init().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  🎲  Spielwirbel running at  http://localhost:${PORT}\n`);
    console.log(`      Persistence:          ${process.env.DATABASE_URL ? 'PostgreSQL (DATABASE_URL)' : DATA_FILE}`);
    console.log(`      Images are stored in: ${imagesLocation}\n`);
  });
}).catch((err) => {
  console.error('Failed to initialise the data backend:', err.message);
  process.exit(1);
});
