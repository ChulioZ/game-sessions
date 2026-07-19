'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../lib/providers/psstore');

// A minimal store page: the __NEXT_DATA__ blob holds an Apollo cache with a mix
// of full games and a DLC (which must be filtered out).
function pageHtml(apolloState, extraBody = '') {
  const next = { props: { pageProps: { apolloState } } };
  return `<!doctype html><html><head></head><body>${extraBody}
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>
    </body></html>`;
}

const SEARCH_STATE = {
  'Product:AAA': {
    __typename: 'Product',
    id: 'AAA',
    name: 'The Witcher 3: Wild Hunt',
    storeDisplayClassification: 'FULL_GAME',
    media: [
      { __typename: 'Media', role: 'SCREENSHOT', type: 'IMAGE', url: 'https://image.api.playstation.com/vulcan/shot.jpg' },
      { __typename: 'Media', role: 'GAMEHUB_COVER_ART', type: 'IMAGE', url: 'https://image.api.playstation.com/vulcan/witcher.png' },
    ],
  },
  'Product:BBB': {
    __typename: 'Product',
    id: 'BBB',
    name: 'The Witcher 3 - Expansion Pass',
    storeDisplayClassification: 'GAME_CONSUMABLE', // DLC -> excluded
    media: [],
  },
  'Product:CCC': {
    __typename: 'Product',
    id: 'CCC',
    name: 'Rocket League',
    storeDisplayClassification: 'FULL_GAME',
    media: [{ __typename: 'Media', role: 'MASTER', type: 'IMAGE', url: 'https://image.api.playstation.com/vulcan/rl.png' }],
  },
};

test('parseSearch returns only full games, with best cover thumbnail', () => {
  const out = ps.parseSearch(pageHtml(SEARCH_STATE));
  assert.equal(out.length, 2); // DLC filtered out
  assert.deepEqual(out[0], {
    providerId: 'AAA',
    title: 'The Witcher 3: Wild Hunt',
    thumbnail: 'https://image.api.playstation.com/vulcan/witcher.png', // cover role beats screenshot
  });
  assert.equal(out[1].title, 'Rocket League');
});

test('parseSearch respects the limit and tolerates a missing blob', () => {
  assert.equal(ps.parseSearch(pageHtml(SEARCH_STATE), 1).length, 1);
  assert.deepEqual(ps.parseSearch('<html>no next data</html>'), []);
});

test('pickImage prefers cover roles then falls back to any image', () => {
  assert.equal(
    ps.pickImage([
      { type: 'IMAGE', role: 'SCREENSHOT', url: 'a' },
      { type: 'IMAGE', role: 'MASTER', url: 'b' },
    ]),
    'b'
  );
  assert.equal(ps.pickImage([{ type: 'IMAGE', role: 'SCREENSHOT', url: 'only' }]), 'only');
  assert.equal(ps.pickImage([{ type: 'VIDEO', role: 'PREVIEW', url: 'v' }]), null);
  assert.equal(ps.pickImage(null), null);
});

test('parsePlayers reads single counts and ranges, prefers the widest', () => {
  assert.deepEqual(ps.parsePlayers('x compatText">1 player</span> y'), { min: 1, max: 1 });
  assert.deepEqual(ps.parsePlayers('compatText">1 - 4 players</span>'), { min: 1, max: 4 });
  // widest range wins over a bare single count elsewhere on the page
  assert.deepEqual(
    ps.parsePlayers('compatText">4 players</span> ... compatText">1 - 4 players</span>'),
    { min: 1, max: 4 }
  );
  assert.deepEqual(ps.parsePlayers('no players spec here'), { min: null, max: null });
});

test('parsePlayers handles the German store (Spieler + en-dash) and skips online counts', () => {
  assert.deepEqual(ps.parsePlayers('compatText">1 Spieler</span>'), { min: 1, max: 1 });
  assert.deepEqual(ps.parsePlayers('compatText">1 – 4 Spieler</span>'), { min: 1, max: 4 }); // en-dash
  // "8 Online-Spieler" must not be read as the local player count
  assert.deepEqual(ps.parsePlayers('compatText">8 Online-Spieler</span>'), { min: null, max: null });
  assert.deepEqual(
    ps.parsePlayers('compatText">1 – 4 Spieler</span> compatText">8 Online-Spieler</span>'),
    { min: 1, max: 4 }
  );
});

test('parseProduct maps the matching product + players, digital', () => {
  const html = pageHtml(
    { 'Product:CCC': SEARCH_STATE['Product:CCC'] },
    '<div><span class="compatText">1 - 4 players</span></div>'
  );
  const d = ps.parseProduct(html, 'CCC', 'de-de');
  assert.equal(d.provider, 'psstore');
  assert.equal(d.externalId, 'CCC');
  assert.equal(d.title, 'Rocket League');
  assert.equal(d.type, 'digital');
  assert.equal(d.minPlayers, 1);
  assert.equal(d.maxPlayers, 4);
  assert.equal(d.imageUrl, 'https://image.api.playstation.com/vulcan/rl.png');
  assert.equal(d.url, 'https://store.playstation.com/de-de/product/CCC');
});

test('parseProduct still returns a usable object when the page has no product stub', () => {
  // Real product pages sometimes carry no rich Product; we still return the
  // digital type, the source url, and any scraped player count.
  const d = ps.parseProduct('<span class="compatText">1 – 4 Spieler</span>', 'CCC', 'de-de');
  assert.equal(d.provider, 'psstore');
  assert.equal(d.externalId, 'CCC');
  assert.equal(d.title, null);
  assert.equal(d.imageUrl, null);
  assert.equal(d.type, 'digital');
  assert.equal(d.minPlayers, 1);
  assert.equal(d.maxPlayers, 4);
  assert.equal(d.url, 'https://store.playstation.com/de-de/product/CCC');
});

test('imageHostAllowed only vouches for Sony image hosts', () => {
  assert.equal(ps.imageHostAllowed('https://image.api.playstation.com/vulcan/x.png'), true);
  assert.equal(ps.imageHostAllowed('https://gs2.ww.prod.dl.playstation.net/x.png'), true);
  assert.equal(ps.imageHostAllowed('https://evil.example.com/x.png'), false);
  assert.equal(ps.imageHostAllowed('file:///etc/passwd'), false);
  assert.equal(ps.imageHostAllowed('not a url'), false);
  // suffix-spoofing guard
  assert.equal(ps.imageHostAllowed('https://playstation.net.evil.com/x'), false);
});
