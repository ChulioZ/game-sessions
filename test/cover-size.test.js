'use strict';

// Render-time cover URL sizing (#298). The sizer runs on every cover the app
// paints, so its pass-through behaviour matters as much as its rewriting: a
// stray query appended to an own upload or an unrecognised host would break a
// cover that works today.

const test = require('node:test');
const assert = require('node:assert');

const {
  COVER_THUMB,
  COVER_CARD,
  COVER_HERO,
  coverUrl,
} = require('../public/js/cover-size');

const { isAllowedImageUrl, providerCoverUrl } = require('../lib/providers');

test('resizes a PlayStation Store cover', () => {
  const url = 'https://image.api.playstation.com/vulcan/ap/rnd/202309/1215/abc.png';
  assert.strictEqual(coverUrl(url, COVER_CARD), `${url}?w=330`);
  assert.strictEqual(coverUrl(url, COVER_THUMB), `${url}?w=160`);
});

test('resizes a playstation.net subdomain cover', () => {
  const url = 'https://apollo2.dl.playstation.net/cdn/cover.jpg';
  assert.strictEqual(coverUrl(url, COVER_HERO), `${url}?w=480`);
});

test('resizes an Xbox cover with the width/height/quality triple', () => {
  const url = 'https://store-images.s-microsoft.com/image/apps.64416.138287.abc';
  assert.strictEqual(coverUrl(url, COVER_CARD), `${url}?w=330&h=330&q=90`);
});

test('passes through the providers that are already right-sized', () => {
  // BGG ships a fit-in transform, Steam a capsule crop, and Nintendo's CDN
  // ignores ?w= outright — appending to any of them would be pure noise.
  const urls = [
    'https://cf.geekdo-images.com/abc/fit-in/246x300/pic123.jpg',
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/c.jpg',
    'https://www.nintendo.com/eu/media/images/assets/game/cover.jpg',
  ];
  urls.forEach((u) => assert.strictEqual(coverUrl(u, COVER_CARD), u));
});

test('passes through own uploads byte-identically', () => {
  assert.strictEqual(coverUrl('/uploads/abc123.jpg', COVER_CARD), '/uploads/abc123.jpg');
});

test('passes through an unrecognised host', () => {
  const url = 'https://example.com/cover.jpg';
  assert.strictEqual(coverUrl(url, COVER_CARD), url);
});

test('leaves a URL that already carries a query string alone', () => {
  // Not hypothetical: the Xbox *search* hit arrives pre-sized as ?w=150&h=150,
  // and a second w= would produce a malformed query.
  const url = 'https://store-images.s-microsoft.com/image/apps.1.abc?w=150&h=150';
  assert.strictEqual(coverUrl(url, COVER_CARD), url);
});

test('passes through non-https and non-string values untouched', () => {
  assert.strictEqual(coverUrl('http://image.api.playstation.com/a.png', 330),
    'http://image.api.playstation.com/a.png');
  assert.strictEqual(coverUrl(null, 330), null);
  assert.strictEqual(coverUrl(undefined, 330), undefined);
  assert.strictEqual(coverUrl('', 330), '');
});

test('passes through an unparseable https value', () => {
  assert.strictEqual(coverUrl('https://', 330), 'https://');
});

test('the sized URLs still clear the server-side cover guard', () => {
  // providerCoverUrl() rejects quotes, parens, backslashes and whitespace
  // because game.image is interpolated into background-image:url('…'). Verify
  // rather than assume that the appended query trips none of them (#298 §4).
  [
    'https://image.api.playstation.com/vulcan/ap/rnd/202309/1215/abc.png',
    'https://store-images.s-microsoft.com/image/apps.64416.138287.abc',
  ].forEach((url) => {
    assert.ok(isAllowedImageUrl(url), `${url} should be an allowed host`);
    [COVER_THUMB, COVER_CARD, COVER_HERO].forEach((w) => {
      const sized = coverUrl(url, w);
      assert.notStrictEqual(sized, url, 'expected the URL to be rewritten');
      assert.strictEqual(providerCoverUrl(sized), sized,
        `${sized} must survive the server guard unchanged`);
    });
  });
});
