'use strict';

/* S3-compatible object-storage backend for cover images (issue #128).
 * Selected by ./index.js when S3_BUCKET is set; otherwise ./disk.js is used.
 *
 * The stored public path stays '/uploads/<id><ext>' exactly as with disk
 * storage, so nothing else in the app changes: the frontend still renders
 * same-origin /uploads URLs, the CSP (img-src 'self') is untouched, /uploads
 * stays behind the auth gate, and existing data.json paths keep working. Only
 * the bytes move off local disk.
 *
 * The app streams objects back through GET /uploads/<key> (a read-through
 * proxy) instead of exposing the bucket publicly. That is deliberate: cover
 * images are user data, so keeping them behind the app preserves the same auth
 * gate the disk backend has and avoids a cross-origin CSP allowance. The extra
 * bandwidth through the app tier is negligible for this app's scale.
 *
 * Works with any S3-compatible store (AWS S3, Cloudflare R2, Backblaze B2,
 * MinIO) via a configurable endpoint. Exported as a factory so tests can inject
 * a fake client + bucket and drive it with no network — see test/storage.test.js. */

const path = require('path');
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  ListObjectsV2Command, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { id } = require('../store');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const isTrue = (v) => v === 'true' || v === '1';

// Build an S3Client from the S3_* env. Credentials are optional here: when
// S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are unset the SDK's default provider
// chain resolves them (AWS_* env, IAM role, …). A custom endpoint (+ path style)
// covers R2 / MinIO / B2.
function clientFromEnv() {
  const cfg = { region: process.env.S3_REGION || 'us-east-1' };
  if (process.env.S3_ENDPOINT) cfg.endpoint = process.env.S3_ENDPOINT;
  if (isTrue(process.env.S3_FORCE_PATH_STYLE)) cfg.forcePathStyle = true;
  if (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY) {
    cfg.credentials = {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    };
  }
  return new S3Client(cfg);
}

function createS3Storage(opts = {}) {
  const client = opts.client || clientFromEnv();
  const bucket = opts.bucket || process.env.S3_BUCKET;
  // Optional key prefix (e.g. 'uploads/') to namespace objects in a shared
  // bucket. It is an internal detail, not part of the public /uploads/<key> path.
  const prefix = opts.prefix != null ? opts.prefix : (process.env.S3_PREFIX || '');
  const keyOf = (name) => prefix + name;

  async function save(buffer, ext) {
    const name = id() + ext;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: keyOf(name),
      Body: buffer,
      ContentType: MIME_BY_EXT[ext] || 'application/octet-stream',
    }));
    return '/uploads/' + name;
  }

  async function remove(publicPath) {
    if (!publicPath) return;
    try {
      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: keyOf(path.basename(publicPath)),
      }));
    } catch { /* best effort: a missing object is fine */ }
  }

  // Delete EVERY object under the configured prefix and return how many went
  // away. Operator-only, used by the one-time cover purge (#172) — see
  // routes/admin.js. Paginates because ListObjectsV2 caps at 1000 keys per page,
  // and re-lists from the start each round since the deletes shrink the listing.
  async function removeAll() {
    let removed = 0;
    for (;;) {
      const listed = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
      }));
      const keys = (listed.Contents || []).map((o) => ({ Key: o.Key }));
      if (keys.length === 0) return removed;
      const out = await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys, Quiet: true },
      }));
      // Count what actually went; stop if a page made no progress so a bucket
      // whose deletes are all refused can't spin here forever.
      const failed = (out && out.Errors ? out.Errors.length : 0);
      const gone = keys.length - failed;
      if (gone === 0) return removed;
      removed += gone;
    }
  }

  // Read-through proxy for GET /uploads/<key>. Mounted behind requireAuth in
  // lib/app.js, so it inherits the same auth gate the disk backend has. basename
  // strips any path traversal; keys are only ever '<id><ext>'.
  async function serve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(405);
    const key = keyOf(path.basename(req.path));
    let out;
    try {
      out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return res.sendStatus(404);
      }
      return res.sendStatus(502);
    }
    res.type(out.ContentType || MIME_BY_EXT[path.extname(key)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (req.method === 'HEAD') return res.end();
    out.Body.on('error', () => { if (res.headersSent) res.destroy(); else res.sendStatus(502); });
    return out.Body.pipe(res);
  }

  return { save, remove, removeAll, serve, backend: 's3' };
}

module.exports = createS3Storage;
