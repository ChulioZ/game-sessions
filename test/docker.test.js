'use strict';

// Container guardrails (issue #131). These are static assertions over the
// Dockerfile / .dockerignore text — no Docker daemon needed — so they run in the
// ordinary `npm test` suite and catch the ways a container change quietly goes
// wrong: baking secrets or user data into a shipped image, dropping the non-root
// user, moving data off the mountable volume, or a silent base-image bump.

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

test('Dockerfile keeps data on a mountable /data volume, in production mode', () => {
  const df = read('Dockerfile');
  assert.match(df, /ENV\s+DATA_DIR=\/data/, 'DATA_DIR should point at /data');
  assert.match(df, /^VOLUME\s+\/data\s*$/m, '/data should be a volume');
  assert.match(df, /ENV\s+NODE_ENV=production/, 'should run in production mode');
  assert.match(df, /CMD\s+\[\s*"node"\s*,\s*"server\.js"\s*\]/, 'should start the server');
});

test('.dockerignore keeps secrets and user data out of the build context', () => {
  const ignore = read('.dockerignore')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  // The critical guard: never bake the group's private data/ folder or a local
  // .env (which may hold ANTHROPIC_API_KEY) into a shipped image.
  for (const entry of ['data', '.env', 'node_modules', '.git']) {
    assert.ok(ignore.includes(entry), `.dockerignore must exclude ${entry}`);
  }
});
