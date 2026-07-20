'use strict';

/* Provider cover art is HOTLINKED, never re-hosted (#172).
 *
 * Two guards carry that decision, and both fail dangerously rather than loudly
 * if they regress — hence this file:
 *   - providerCoverUrl() decides what may be STORED as a game's cover;
 *   - lib/storage's remove() must ignore anything that isn't ours to delete.
 * See .claude/rules/provider-cover-hotlinking.md. */

// helpers points DATA_DIR at a fresh temp folder before the store is required,
// so the storage case below writes into an isolated uploads dir.
require('./helpers');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { providerCoverUrl, isAllowedImageUrl, imageCspSources } = require('../lib/providers');

test('providerCoverUrl keeps an allowlisted https cover URL verbatim', () => {
  const urls = [
    'https://cf.geekdo-images.com/abc/pic123.jpg',
    // A real BGG CDN cover: parens in `filters:strip_icc()` are legal inside the
    // quoted url('…') the frontend emits, and rejecting them silently dropped
    // every BGG cover — caught only in a browser, since nothing logs it.
    'https://cf.geekdo-images.com/W3Bsga_uLP9kO91gZ7H8yw__itemrep/img/IzYEUm_gWFuRFOL8gQYqGm5gU6A=/fit-in/246x300/filters:strip_icc()/pic2419375.jpg',
    'https://image.api.playstation.com/vulcan/x.png',
    'https://store-images.s-microsoft.com/image/apps.1.jpg',
    'https://www.nintendo.com/eu/media/images/mk8.jpg',
    'https://cdn.akamai.steamstatic.com/steam/apps/570/header.jpg',
  ];
  for (const u of urls) assert.equal(providerCoverUrl(u), u);
});

test('providerCoverUrl refuses a host no provider vouches for', () => {
  assert.equal(providerCoverUrl('https://evil.example.com/x.png'), null);
  // A lookalike must not pass on a suffix match.
  assert.equal(providerCoverUrl('https://cf.geekdo-images.com.evil.tld/x.png'), null);
});

test('providerCoverUrl refuses http, so a stored cover is never mixed content', () => {
  // http would be blocked by the browser on the HTTPS origin and render nothing,
  // with no server-side error to notice.
  assert.equal(providerCoverUrl('http://cf.geekdo-images.com/x.jpg'), null);
  assert.equal(isAllowedImageUrl('http://cf.geekdo-images.com/x.jpg'), true); // ...though the host itself is fine
});

test('providerCoverUrl refuses characters that would break out of url(\'…\')', () => {
  // The frontend interpolates game.image straight into
  // `background-image:url('<image>')`, so a quote or paren in a stored URL is a
  // CSS-injection vector. Rejecting at the trust boundary keeps every render
  // site safe without escaping at each one.
  const nasty = [
    "https://cf.geekdo-images.com/x'.jpg",          // ends the CSS string
    'https://cf.geekdo-images.com/x".jpg',          // ends the style="…" attribute
    'https://cf.geekdo-images.com/x\\.jpg',         // starts a CSS escape
    'https://cf.geekdo-images.com/x .jpg',
    'https://cf.geekdo-images.com/x\n.jpg',
    'https://cf.geekdo-images.com/x<.jpg',
    "https://cf.geekdo-images.com/a.jpg');background:url('https://evil.tld/x.jpg",
    'https://cf.geekdo-images.com/a.jpg" onload="alert(1)',
  ];
  for (const u of nasty) assert.equal(providerCoverUrl(u), null, `must reject ${u}`);
});

test('providerCoverUrl refuses junk without throwing', () => {
  for (const v of [null, undefined, '', 'not a url', 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
    assert.equal(providerCoverUrl(v), null);
  }
});

test('every hotlinkable host is renderable under the CSP', () => {
  // A stored hotlink is only useful if img-src permits it — the same coupling
  // test/security.test.js asserts from the app side, checked here from the
  // provider side so a new provider can't ship a cover the browser blocks.
  const sources = imageCspSources();
  const hosts = ['cf.geekdo-images.com', 'image.api.playstation.com', 'store-images.s-microsoft.com'];
  for (const h of hosts) {
    const ok = sources.some((s) => s === h || (s.startsWith('*.') && h.endsWith(s.slice(1))));
    assert.ok(ok, `${h} must be covered by img-src`);
  }
});

test('storage.remove ignores a hotlinked cover instead of deleting our object', async () => {
  // The real trap: both backends take path.basename() of what they are given, so
  // remove('https://cf.geekdo-images.com/x/pic123.jpg') would delete OUR stored
  // object named 'pic123.jpg'. The guard lives in lib/storage/index.js so every
  // deletion path (games PATCH/DELETE, admin takedown, account erasure) is safe.
  const path = require('node:path');
  const fs = require('node:fs');
  const store = require('../lib/store');
  const storage = require('../lib/storage');

  const saved = await storage.save(Buffer.from([1, 2, 3, 4]), '.jpg');
  const file = path.join(store.UPLOAD_DIR, path.basename(saved));
  assert.ok(fs.existsSync(file));

  // A remote URL whose basename collides with the stored object.
  await storage.remove('https://cf.geekdo-images.com/x/' + path.basename(saved));
  assert.ok(fs.existsSync(file), 'a hotlink must never delete a stored object');

  assert.equal(storage.isHostedImage(saved), true);
  assert.equal(storage.isHostedImage('https://cf.geekdo-images.com/x/p.jpg'), false);

  // ...and the real path still deletes.
  await storage.remove(saved);
  assert.equal(fs.existsSync(file), false);
});
