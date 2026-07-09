'use strict';

/*
 * Familien-Spielesammlung – small local server.
 *
 * Persistence: a single file data/data.json (see lib/store.js).
 * Images: stored as files under data/uploads/; data.json only holds the path.
 *
 * Start:  npm start   ->  http://localhost:3000
 *
 * Note: intentionally no authentication – meant for a local home network only.
 */

const { DATA_FILE, UPLOAD_DIR } = require('./lib/store');
const { createApp } = require('./lib/app');

const app = createApp();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  🎲  Familien-Spielesammlung running at  http://localhost:${PORT}\n`);
  console.log(`      Data is stored in:   ${DATA_FILE}`);
  console.log(`      Images are stored in: ${UPLOAD_DIR}\n`);
});
