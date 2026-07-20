'use strict';

// Issue #281: linking a game to a PlayStation Store match offered no cover,
// because psstore.detail() returns imageUrl: null by design (the product page's
// __NEXT_DATA__ stubs the product; the cover only exists on the search hit).
// providerMatchCover() closes that gap for the link-provider flow, mirroring
// what the add-game flow already did.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { providerMatchCover } = require('../public/js/lookup-cover');
const psstore = require('../lib/providers/psstore');
const { providerCoverUrl } = require('../lib/providers');

const IMG = 'https://image.api.playstation.com/vulcan/ap/rnd/cover.png';

test('falls back to the search thumbnail when detail carries no image (PS Store)', () => {
  const r = { provider: 'psstore', providerId: 'EP0001', title: 'Hades', thumbnail: IMG };
  const d = { title: 'Hades', imageUrl: null, minPlayers: 1, maxPlayers: 1 };
  assert.equal(providerMatchCover(r, d), IMG);
});

test('the detail image wins whenever the provider returns one', () => {
  const detail = 'https://cf.geekdo-images.com/detail.jpg';
  const r = { provider: 'bgg', thumbnail: 'https://cf.geekdo-images.com/thumb.jpg' };
  assert.equal(providerMatchCover(r, { imageUrl: detail }), detail);
});

test('yields null when neither side has an image, so no cover field is offered', () => {
  assert.equal(providerMatchCover({ thumbnail: null }, { imageUrl: null }), null);
  assert.equal(providerMatchCover({}, {}), null);
});

// The fallback is only safe because a search thumbnail comes from the same
// pickImage() helper — and therefore the same IMAGE_HOSTS — as a detail cover.
// If that ever diverged, the PATCH route would silently drop the URL
// (providerCoverUrl returns null → "an untrusted URL keeps the old cover").
test('a PS Store search thumbnail passes the server cover allowlist', () => {
  assert.equal(providerCoverUrl(IMG), IMG);
});

// Guards the precondition the fallback exists for: a PS Store product page
// really does yield no image, while a search page yields one.
test('psstore parseProduct has no image while parseSearch does', () => {
  const product = {
    props: {
      apolloState: {
        'Product:EP0001': { __typename: 'Product', id: 'EP0001', name: 'Hades' },
      },
    },
  };
  const search = {
    props: {
      apolloState: {
        'Product:EP0001': {
          __typename: 'Product',
          id: 'EP0001',
          name: 'Hades',
          storeDisplayClassification: 'FULL_GAME',
          media: [{ role: 'MASTER', type: 'IMAGE', url: IMG }],
        },
      },
    },
  };
  const html = (data) =>
    `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;

  const detail = psstore.parseProduct(html(product), 'EP0001');
  assert.equal(detail.title, 'Hades'); // the stub does yield a title …
  assert.equal(detail.imageUrl, null); // … but never a cover

  const hits = psstore.parseSearch(html(search));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].thumbnail, IMG);

  // Together these are exactly the #281 case: detail null, search populated.
  assert.equal(providerMatchCover(hits[0], detail), IMG);
});
