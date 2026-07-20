'use strict';

/*
 * Cover-image storage backends (issue #128). The disk backend is the default
 * exercised end-to-end by test/games.test.js already; here we cover both
 * backends' contract directly — save -> serve -> remove — and, crucially, the
 * S3 backend, which is driven with a fake client so it needs no network and no
 * real bucket (mirrors the "stub the network" rule the provider tests follow).
 */

// helpers points DATA_DIR at a fresh temp folder before the store is required,
// so the disk backend writes into an isolated uploads dir.
require('./helpers');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('node:stream');
const express = require('express');
const request = require('supertest');

const store = require('../lib/store');
const disk = require('../lib/storage/disk');
const createS3Storage = require('../lib/storage/s3');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// Mount a backend's `serve` handler on a bare app so we can drive real HTTP GETs.
function serveApp(storage) {
  const app = express();
  app.use('/uploads', storage.serve);
  return app;
}

// An in-memory stand-in for an S3 client: records the commands it receives and
// keeps objects in a Map. Branches on the SDK command class name.
function fakeS3() {
  const objects = new Map(); // Key -> { body: Buffer, contentType }
  const puts = [];
  const client = {
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = cmd.input;
      if (name === 'PutObjectCommand') {
        puts.push({ Key: input.Key, ContentType: input.ContentType });
        objects.set(input.Key, { body: Buffer.from(input.Body), contentType: input.ContentType });
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(input.Key);
        return {};
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = input.Prefix || '';
        return {
          Contents: [...objects.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((Key) => ({ Key })),
        };
      }
      if (name === 'DeleteObjectsCommand') {
        for (const o of input.Delete.Objects) objects.delete(o.Key);
        return { Errors: [] };
      }
      if (name === 'GetObjectCommand') {
        const obj = objects.get(input.Key);
        if (!obj) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return { Body: Readable.from(obj.body), ContentType: obj.contentType };
      }
      throw new Error('unexpected command ' + name);
    },
  };
  return { client, objects, puts };
}

/* --------------------------------- disk ----------------------------------- */

test('disk: save writes the file and returns a /uploads path', async () => {
  const p = await disk.save(PNG, '.png');
  assert.match(p, /^\/uploads\/[0-9a-f]+\.png$/);
  const file = path.join(store.UPLOAD_DIR, path.basename(p));
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fs.readFileSync(file), PNG);
});

test('disk: serve streams the bytes, remove deletes them (404 after)', async () => {
  const p = await disk.save(PNG, '.png');
  const app = serveApp(disk);

  const ok = await request(app).get(p);
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /image\/png/);
  assert.deepEqual(ok.body, PNG);

  await disk.remove(p);
  assert.ok(!fs.existsSync(path.join(store.UPLOAD_DIR, path.basename(p))));
  const gone = await request(app).get(p);
  assert.equal(gone.status, 404);
});

test('disk: remove is a no-op for a missing/absent path (never throws)', async () => {
  await disk.remove(null);
  await disk.remove('/uploads/does-not-exist.png');
});

/* ---------------------------------- s3 ------------------------------------ */

test('s3: save PUTs the object with the right key + content-type', async () => {
  const { client, objects, puts } = fakeS3();
  const s3 = createS3Storage({ client, bucket: 'test-bucket' });

  const p = await s3.save(PNG, '.png');
  assert.match(p, /^\/uploads\/[0-9a-f]+\.png$/);
  const key = path.basename(p);
  assert.ok(objects.has(key));
  assert.equal(puts.length, 1);
  assert.equal(puts[0].Key, key);
  assert.equal(puts[0].ContentType, 'image/png');
});

test('s3: a key prefix namespaces objects but not the public path', async () => {
  const { client, objects } = fakeS3();
  const s3 = createS3Storage({ client, bucket: 'test-bucket', prefix: 'covers/' });

  const p = await s3.save(PNG, '.png');
  assert.match(p, /^\/uploads\/[0-9a-f]+\.png$/); // public path has no prefix
  assert.ok(objects.has('covers/' + path.basename(p))); // object key does
});

test('s3: serve streams the object back with its content-type', async () => {
  const { client } = fakeS3();
  const s3 = createS3Storage({ client, bucket: 'test-bucket' });
  const p = await s3.save(PNG, '.png');

  const res = await request(serveApp(s3)).get(p);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/png/);
  assert.match(res.headers['cache-control'], /immutable/);
  assert.deepEqual(res.body, PNG);
});

test('s3: serve 404s a missing key, remove deletes an existing one', async () => {
  const { client } = fakeS3();
  const s3 = createS3Storage({ client, bucket: 'test-bucket' });
  const app = serveApp(s3);

  assert.equal((await request(app).get('/uploads/nope.png')).status, 404);

  const p = await s3.save(PNG, '.png');
  assert.equal((await request(app).get(p)).status, 200);
  await s3.remove(p);
  assert.equal((await request(app).get(p)).status, 404);
});

test('s3: serve rejects non-GET/HEAD with 405', async () => {
  const { client } = fakeS3();
  const s3 = createS3Storage({ client, bucket: 'test-bucket' });
  const res = await request(serveApp(s3)).post('/uploads/whatever.png');
  assert.equal(res.status, 405);
});

test('s3: remove swallows client errors (best effort)', async () => {
  const client = { async send() { throw new Error('network down'); } };
  const s3 = createS3Storage({ client, bucket: 'test-bucket' });
  await s3.remove('/uploads/x.png'); // must not throw
});

/* ------------------------- removeAll (one-time purge) ---------------------- */

test('disk: removeAll deletes every stored file, referenced or orphaned', async () => {
  const a = await disk.save(PNG, '.png');
  const b = await disk.save(PNG, '.png');
  // Earlier cases in this file share the temp uploads dir, so the count is
  // relative — what matters is that the sweep leaves nothing behind.
  assert.ok(await disk.removeAll() >= 2);
  for (const p of [a, b]) {
    assert.equal(fs.existsSync(path.join(store.UPLOAD_DIR, path.basename(p))), false);
  }
  assert.deepEqual(fs.readdirSync(store.UPLOAD_DIR), []);
  // An empty dir is an honest zero, not an error.
  assert.equal(await disk.removeAll(), 0);
});

test('s3: removeAll deletes every object under the prefix', async () => {
  const { client, objects } = fakeS3();
  const s3 = createS3Storage({ client, bucket: 'test-bucket', prefix: 'covers/' });
  await s3.save(PNG, '.png');
  await s3.save(PNG, '.jpg');
  // An object outside the prefix belongs to someone else — it must survive.
  objects.set('other/keep.png', { body: PNG, contentType: 'image/png' });

  assert.equal(await s3.removeAll(), 2);
  assert.deepEqual([...objects.keys()], ['other/keep.png']);
  assert.equal(await s3.removeAll(), 0);
});

test('s3: removeAll stops instead of spinning when deletes are refused', async () => {
  // A bucket that refuses every delete would otherwise loop forever, because the
  // listing never shrinks.
  const client = {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === 'ListObjectsV2Command') return { Contents: [{ Key: 'stuck.png' }] };
      if (name === 'DeleteObjectsCommand') return { Errors: [{ Key: 'stuck.png' }] };
      throw new Error('unexpected command ' + name);
    },
  };
  const s3 = createS3Storage({ client, bucket: 'test-bucket' });
  assert.equal(await s3.removeAll(), 0);
});
