'use strict';

/*
 * Cover-image storage — picks the backend once, at require time (issue #128),
 * mirroring lib/repo/index.js.
 *
 *   S3_BUCKET set -> ./s3.js   (S3-compatible object storage; the stateless
 *                               app-tier path for a hosted deployment)
 *   otherwise     -> ./disk.js (the default: files under DATA_DIR/uploads)
 *
 * Both expose the same tiny contract — async save(buffer, ext) -> '/uploads/<key>',
 * async remove(publicPath), and an Express `serve` handler mounted at /uploads —
 * so nothing else in the app changes when the backend does. The default stays
 * local disk, so local dev, existing installs, and the test suite need no S3 (and
 * the @aws-sdk/client-s3 dependency is only loaded when S3 is configured).
 */

const backend = process.env.S3_BUCKET ? require('./s3')() : require('./disk');

// True only for a cover WE host, i.e. a '/uploads/<key>' path.
//
// Since #172 a game's `image` may instead be a hotlinked provider URL
// (https://cf.geekdo-images.com/…). There are no bytes of ours behind one, and
// handing it to a backend's remove() would be actively harmful: both backends
// take path.basename() of what they're given, so a remote URL ending in
// '/pic123.jpg' would delete OUR object named 'pic123.jpg'. Guarding here rather
// than at each call site keeps every deletion path (games PATCH/DELETE, admin
// takedown, account erasure) safe by construction.
const isHostedImage = (p) => typeof p === 'string' && p.startsWith('/uploads/');

module.exports = {
  ...backend,
  remove: async (publicPath) => {
    if (!isHostedImage(publicPath)) return;
    await backend.remove(publicPath);
  },
  // Guarded for the same reason as remove(): the backends take path.basename()
  // of what they are given, so a hotlinked provider URL ending in '/pic123.jpg'
  // would size OUR object of that name and report a stranger's bytes as this
  // tenant's. A provider cover costs us nothing, so null ("not ours") is also
  // the honest answer.
  size: async (publicPath) => (isHostedImage(publicPath) ? backend.size(publicPath) : null),
  isHostedImage,
};
