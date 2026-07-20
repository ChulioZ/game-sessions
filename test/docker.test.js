'use strict';

// Container + deploy guardrails (issue #131). These are static assertions over
// the Dockerfile / .dockerignore / railway.json text — no Docker daemon or
// network needed — so they run in the ordinary `npm test` suite and catch the
// ways a container/deploy change quietly goes wrong: baking secrets or user data
// into a shipped image, dropping the non-root user, moving data off the mountable
// volume, a silent base-image bump, or a Railway config that stops building the
// Dockerfile / health-checks the wrong path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('Dockerfile pins the node:22-slim base (a bump is deliberate)', () => {
  const bases = [...read('Dockerfile').matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  assert.ok(bases.length >= 1, 'expected at least one FROM');
  for (const b of bases) assert.match(b, /^node:22-slim$/, `unexpected base image: ${b}`);
});

test('Dockerfile runs as the non-root node user', () => {
  assert.match(read('Dockerfile'), /^USER\s+node\s*$/m, 'image must drop to USER node');
});

test('Dockerfile keeps data on the mountable /data path, in production mode', () => {
  const df = read('Dockerfile');
  assert.match(df, /ENV\s+DATA_DIR=\/data/, 'DATA_DIR should point at /data');
  // Must NOT declare a Dockerfile `VOLUME`: Railway's Metal builder rejects the
  // instruction ("use Railway Volumes"). Persistence is a platform/compose volume
  // mounted at /data instead — see .claude/rules/railway-no-dockerfile-volume.md.
  assert.doesNotMatch(df, /^\s*VOLUME\b/m, 'no Dockerfile VOLUME (Railway rejects it)');
  assert.match(df, /ENV\s+NODE_ENV=production/, 'should run in production mode');
  assert.match(df, /CMD\s+\[\s*"node"\s*,\s*"server\.js"\s*\]/, 'should start the server');
});

test('.dockerignore keeps secrets and user data out of the build context', () => {
  const ignore = read('.dockerignore')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  // The critical guard: never bake the group's private data/ folder or a local
  // .env (which may hold SESSION_SECRET / BREVO_API_KEY) into a shipped image.
  for (const entry of ['data', '.env', 'node_modules', '.git']) {
    assert.ok(ignore.includes(entry), `.dockerignore must exclude ${entry}`);
  }
});

test('railway.json builds the Dockerfile and health-checks the real /healthz', () => {
  const cfg = JSON.parse(read('railway.json')); // also asserts it stays valid JSON
  assert.equal(cfg.build.builder, 'DOCKERFILE');
  assert.equal(cfg.build.dockerfilePath, 'Dockerfile');
  // Must match the unauthenticated probe the app actually serves (lib/app.js).
  assert.equal(cfg.deploy.healthcheckPath, '/healthz');
});
