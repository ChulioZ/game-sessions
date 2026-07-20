'use strict';

/* Local-disk storage backend for cover images — the default (issue #128).
 *
 * Files live under DATA_DIR/uploads and the stored public path is
 * '/uploads/<id><ext>'. This is the behaviour the app has always had, extracted
 * behind the storage seam so an S3 backend can replace it when S3_BUCKET is set
 * (see ./index.js and ./s3.js). Nothing else changes: same-origin /uploads URLs,
 * same auth gate, same data.json paths. */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { UPLOAD_DIR, id } = require('../store');

// Write image bytes and return the public '/uploads/<id><ext>' path stored in
// the DB. The extension is the caller's already-validated one (magic-byte sniff
// in lib/upload.js — provider covers are hotlinked and never stored, #172) —
// never the client
// filename.
async function save(buffer, ext) {
  const key = id() + ext;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, key), buffer);
  return '/uploads/' + key;
}

// Best-effort delete of the file behind a '/uploads/...' path. Never throws — a
// file that's already gone (or was never local) is a no-op.
async function remove(publicPath) {
  if (!publicPath) return;
  await fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(publicPath))).catch(() => {});
}

// Delete EVERY stored cover file and return how many went away. Operator-only,
// used by the one-time cover purge (#172) — see routes/admin.js. Best effort per
// file so one unlink failure doesn't abort the sweep.
async function removeAll() {
  let names;
  try {
    names = await fs.promises.readdir(UPLOAD_DIR);
  } catch {
    return 0; // no upload dir yet = nothing stored
  }
  let removed = 0;
  for (const name of names) {
    try {
      await fs.promises.unlink(path.join(UPLOAD_DIR, name));
      removed += 1;
    } catch { /* already gone, or a directory: skip */ }
  }
  return removed;
}

// Express handler mounted at /uploads (behind requireAuth in lib/app.js): serve
// the files straight off disk.
const serve = express.static(UPLOAD_DIR);

module.exports = { save, remove, removeAll, serve, backend: 'disk' };
