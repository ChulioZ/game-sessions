'use strict';

/*
 * Optional cache-busting build (issue #141).
 *
 * The app runs with NO build step by default (see CLAUDE.md): `npm start` serves
 * public/ as-is. This script is the *optional* production build whose only jobs
 * are the two named in #141 — **content-hashed filenames** (so a changed asset
 * gets a new URL and can't be served stale after a deploy) and **minification**
 * — for `public/js/**` and `public/styles.css`. It is a deliberate, scoped break
 * of the no-build-step rule, not a licence to adopt a bundler or framework.
 *
 * What it does: mirror public/ into dist/, then replace each js/css file with a
 * minified, content-hashed copy (e.g. js/core.js -> js/core.<hash>.js) and
 * rewrite every reference to it in index.html, sw.js and the standalone pages
 * (login.html, admin.html, kontakt.html — see REWRITE_FILES). The service
 * worker's CACHE name is re-derived from the hashed set so a new build
 * auto-invalidates the old shell cache. Everything else (fonts, icons, the
 * manifest, tabler-icons.css) is copied through unchanged — only js + styles.css
 * are in scope.
 *
 * lib/app.js serves dist/ when dist/index.html exists, else public/. So building
 * is opt-in: don't build and you get the live-editable public/ tree; build and
 * the app serves the hashed assets. Delete dist/ to go back to live editing.
 *
 * CRITICAL — never rename identifiers or bundle. The frontend scripts share ONE
 * global scope across files (see .claude/rules/frontend-script-load-order.md), so
 * we minify with `minifyWhitespace`/`minifySyntax` but NOT `minifyIdentifiers`,
 * and per-file (transform, not bundle): renaming a top-level name or merging
 * files would break the cross-file references and the fixed load order.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SRC = path.join(ROOT, 'public');
const DEFAULT_OUT = path.join(ROOT, 'dist');

// Files whose asset references get rewritten to the hashed names. Every
// standalone HTML entry point belongs here: its <script src> is content-hashed
// like any other public/js file, so a page left out would 404 its own script in
// a built production deploy (admin.html — issue #268 — is one of these).
const REWRITE_FILES = ['index.html', 'sw.js', 'login.html', 'admin.html', 'kontakt.html'];

function sha8(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

// Insert the content hash before the final extension: js/core.js ->
// js/core.<hash>.js, styles.css -> styles.<hash>.css (directory preserved).
function hashedRel(rel, hash) {
  const ext = path.posix.extname(rel);
  return rel.slice(0, -ext.length) + '.' + hash + ext;
}

// Collect the assets to hash: every *.js under <out>/js plus <out>/styles.css.
function assetsToHash(outDir) {
  const out = [];
  const jsDir = path.join(outDir, 'js');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.js')) out.push(path.relative(outDir, abs));
    }
  };
  if (fs.existsSync(jsDir)) walk(jsDir);
  if (fs.existsSync(path.join(outDir, 'styles.css'))) out.push('styles.css');
  return out.map((p) => p.split(path.sep).join('/')); // posix rels
}

function minify(rel, code) {
  if (rel.endsWith('.css')) {
    return esbuild.transformSync(code, { loader: 'css', minify: true }).code;
  }
  // JS: whitespace + syntax only. minifyIdentifiers stays OFF — see header.
  return esbuild.transformSync(code, {
    loader: 'js',
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
  }).code;
}

// Replace only properly-quoted references ("…"/'…') to a mapped path, so a path
// can't match as a substring of a longer one (e.g. /js/views-round.js vs
// /js/views-round-tabs.js).
function rewriteRefs(text, manifest) {
  for (const [orig, hashed] of Object.entries(manifest)) {
    const esc = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(["'])${esc}(["'])`, 'g'), `$1${hashed}$2`);
  }
  return text;
}

// A cache name derived from the hashed asset set, so any content change yields a
// new service-worker cache and `activate` drops the stale one automatically.
function deriveCache(manifest) {
  const digest = sha8(Object.values(manifest).sort().join('\n'));
  return `spielwirbel-shell-${digest}`;
}

function build({ srcDir = DEFAULT_SRC, outDir = DEFAULT_OUT } = {}) {
  fs.rmSync(outDir, { recursive: true, force: true });
  // Mirror public/, skipping dotfiles (.DS_Store etc.).
  fs.cpSync(srcDir, outDir, {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith('.'),
  });

  const manifest = {};
  for (const rel of assetsToHash(outDir)) {
    const abs = path.join(outDir, rel);
    const minified = Buffer.from(minify(rel, fs.readFileSync(abs, 'utf8')));
    const hRel = hashedRel(rel, sha8(minified));
    fs.writeFileSync(path.join(outDir, hRel), minified);
    fs.rmSync(abs); // drop the un-hashed copy
    manifest['/' + rel] = '/' + hRel;
  }

  const cache = deriveCache(manifest);
  for (const name of REWRITE_FILES) {
    const abs = path.join(outDir, name);
    if (!fs.existsSync(abs)) continue;
    let text = rewriteRefs(fs.readFileSync(abs, 'utf8'), manifest);
    if (name === 'sw.js') {
      text = text.replace(/const CACHE = '[^']*';/, `const CACHE = '${cache}';`);
    }
    fs.writeFileSync(abs, text);
  }

  return { manifest, cache, outDir };
}

module.exports = { build, hashedRel, rewriteRefs, deriveCache, sha8 };

if (require.main === module) {
  const { manifest, cache, outDir } = build();
  const n = Object.keys(manifest).length;
  process.stdout.write(`Built ${n} hashed asset(s) into ${path.relative(ROOT, outDir)}/ (cache: ${cache})\n`);
}
