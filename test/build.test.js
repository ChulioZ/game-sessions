'use strict';

// The optional cache-busting build (issue #141): scripts/build.js mirrors public/
// into dist/, replacing every public/js/** and styles.css with a minified,
// content-hashed copy and rewriting the references in index.html, sw.js and
// login.html. These tests run the real build (esbuild, no network) into a temp
// dir and assert the output is internally consistent: every reference resolves,
// filenames are hashed, the SW cache name is content-derived, and — crucially for
// this shared-global-scope frontend — identifiers are NOT renamed.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, rewriteRefs, deriveCache } = require('../scripts/build');

const SRC = path.join(__dirname, '..', 'public');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'));
const { manifest, cache } = build({ srcDir: SRC, outDir: OUT });
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

const read = (rel) => fs.readFileSync(path.join(OUT, rel), 'utf8');
const HASH = /\.[0-9a-f]{8}\.(js|css)$/;

// Delimited ("…"/'…') asset references to /js/*.js or /styles.css in a file.
function refs(text) {
  return [...text.matchAll(/["'](\/(?:js\/[^"']+\.js|styles[^"']*\.css))["']/g)].map((m) => m[1]);
}

test('hashes and minifies every js + styles.css asset', () => {
  assert.ok(Object.keys(manifest).length >= 15, 'should hash all js + styles.css');
  assert.ok(manifest['/styles.css'], 'styles.css is hashed');
  assert.ok(manifest['/js/core.js'], 'core.js is hashed');
  for (const [orig, hashed] of Object.entries(manifest)) {
    assert.match(hashed, HASH, `${hashed} carries a content hash`);
    assert.ok(fs.existsSync(path.join(OUT, hashed)), `${hashed} is emitted`);
    assert.ok(!fs.existsSync(path.join(OUT, orig)), `un-hashed ${orig} is removed`);
  }
  // Minification really shrank the file.
  const core = fs.statSync(path.join(OUT, manifest['/js/core.js'])).size;
  const srcCore = fs.statSync(path.join(SRC, 'js', 'core.js')).size;
  assert.ok(core < srcCore, 'core.js is smaller after minification');
});

test('index.html references only the hashed assets', () => {
  const dist = read('index.html');
  const srcRefs = refs(fs.readFileSync(path.join(SRC, 'index.html'), 'utf8'));
  assert.ok(srcRefs.includes('/styles.css') && srcRefs.length > 5, 'sanity: source had raw refs');
  for (const orig of srcRefs) {
    assert.ok(!dist.includes(`"${orig}"`), `no un-hashed ${orig} left in index.html`);
    assert.ok(dist.includes(`"${manifest[orig]}"`), `index.html points at ${manifest[orig]}`);
  }
});

test('service worker precaches the hashed shell with a content-derived cache', () => {
  const sw = read('sw.js');
  const block = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'SHELL list present');
  const shell = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // Every precached entry must resolve to a real emitted file (a missed rewrite
  // would leave an un-hashed /js/x.js here that no longer exists in dist).
  for (const url of shell) {
    assert.ok(fs.existsSync(path.join(OUT, url)), `precached ${url} exists in dist`);
  }
  // The hashed assets are referenced by their hashed names; index.html is not
  // hashed (it is the bootstrap document).
  assert.ok(shell.includes(manifest['/js/core.js']), 'SHELL lists hashed core.js');
  assert.ok(shell.includes('/index.html'), 'SHELL keeps /index.html');

  const cacheName = sw.match(/const CACHE = '([^']*)';/)[1];
  assert.equal(cacheName, cache);
  assert.match(cacheName, /^spieleabend-shell-[0-9a-f]{8}$/);
  assert.notEqual(cacheName, 'spieleabend-shell-v3', 'cache name is derived, not the source literal');
});

test('login.html reference is rewritten too', () => {
  const dist = read('login.html');
  assert.ok(!dist.includes('"/js/login.js"'), 'no un-hashed login.js');
  assert.ok(dist.includes(`"${manifest['/js/login.js']}"`), 'login.html points at hashed login.js');
});

test('does not rename shared top-level identifiers (no minifyIdentifiers)', () => {
  // The frontend shares one global scope across files; renaming a top-level name
  // would break cross-file references. Spot-check that known globals survive.
  const core = read(manifest['/js/core.js']);
  for (const name of ['gameStats', 'applyBackground', 'memberColor']) {
    assert.ok(core.includes(name), `global ${name} is preserved in minified core.js`);
  }
});

test('rewriteRefs replaces only whole, delimited paths (not substrings)', () => {
  const m = { '/js/views-round.js': '/js/views-round.abcd1234.js' };
  const out = rewriteRefs('"/js/views-round.js" and "/js/views-round-tabs.js"', m);
  assert.ok(out.includes('"/js/views-round.abcd1234.js"'), 'exact match rewritten');
  assert.ok(out.includes('"/js/views-round-tabs.js"'), 'longer path left untouched');
});

test('deriveCache is deterministic and content-derived', () => {
  const a = { '/styles.css': '/styles.aaaaaaaa.css' };
  const b = { '/styles.css': '/styles.bbbbbbbb.css' };
  assert.equal(deriveCache(a), deriveCache(a));
  assert.notEqual(deriveCache(a), deriveCache(b));
});
