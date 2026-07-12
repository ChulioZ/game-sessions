'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const xbox = require('../lib/providers/xbox');

// An autosuggest response: ResultSets carry Suggests, each game tagged
// Source 'Game' with a BigCatalogId in Metas and a protocol-relative ImageUrl.
const SEARCH_JSON = {
  Query: 'halo',
  ResultSets: [
    {
      Source: 'searchacs-products',
      Suggests: [
        {
          Source: 'Game',
          Title: 'Halo: Campaign Evolved',
          Url: '//www.microsoft.com/de-de/p/halo-campaign-evolved/9n683tdt5m7r',
          ImageUrl: '//store-images.s-microsoft.com/image/apps.15103.halo.jpg?w=150&h=150',
          Metas: [
            { Key: 'BigCatalogId', Value: '9N683TDT5M7R' },
            { Key: 'ProductType', Value: 'Games' },
          ],
        },
        {
          Source: 'Game',
          Title: 'Halo Infinite',
          Url: '//www.microsoft.com/de-de/p/halo-infinite/9pp5g1f0c2gv',
          ImageUrl: '//store-images.s-microsoft.com/image/apps.9999.infinite.jpg',
          Metas: [{ Key: 'BigCatalogId', Value: '9PP5G1F0C2GV' }],
        },
        {
          // Non-game suggestion (an app / accessory) -> dropped.
          Source: 'App',
          Title: 'Halo Companion',
          Metas: [{ Key: 'BigCatalogId', Value: '9ABCDEF00000' }],
        },
      ],
    },
  ],
};

// A displaycatalog product response: title + images in LocalizedProperties,
// player counts in Properties.Attributes (Xbox Live capability flags).
const DETAIL_JSON = {
  Product: {
    LocalizedProperties: [
      {
        ProductTitle: 'Halo: Campaign Evolved',
        Images: [
          { ImagePurpose: 'Poster', Uri: '//store-images.s-microsoft.com/image/poster', Height: 2160, Width: 1440 },
          { ImagePurpose: 'BoxArt', Uri: '//store-images.s-microsoft.com/image/boxart', Height: 2160, Width: 2160 },
        ],
      },
    ],
    Properties: {
      Attributes: [
        { Name: 'SinglePlayer' },
        { Name: 'XblLocalCoop', Minimum: 2, Maximum: 2 },
        { Name: 'XblOnlineCoop', Minimum: 2, Maximum: 4 },
        { Name: 'XblCrossPlatformCoop' },
      ],
    },
  },
};

test('parseSearch keeps only game suggestions and maps them to normalized results', () => {
  const out = xbox.parseSearch(SEARCH_JSON);
  assert.equal(out.length, 2); // the 'App' suggest is dropped
  assert.deepEqual(out[0], {
    providerId: '9N683TDT5M7R',
    title: 'Halo: Campaign Evolved',
    // protocol-relative image URL made absolute https
    thumbnail: 'https://store-images.s-microsoft.com/image/apps.15103.halo.jpg?w=150&h=150',
  });
  assert.equal(out[1].providerId, '9PP5G1F0C2GV');
});

test('parseSearch respects the limit and tolerates a missing/empty payload', () => {
  assert.equal(xbox.parseSearch(SEARCH_JSON, 1).length, 1);
  assert.deepEqual(xbox.parseSearch({}), []);
  assert.deepEqual(xbox.parseSearch(null), []);
  assert.deepEqual(xbox.parseSearch({ ResultSets: 'nope' }), []);
});

test('parseSearch dedupes by BigCatalogId and skips entries missing id or title', () => {
  const out = xbox.parseSearch({
    ResultSets: [
      {
        Suggests: [
          { Source: 'Game', Title: 'A', Metas: [{ Key: 'BigCatalogId', Value: 'ID1' }] },
          { Source: 'Game', Title: 'A (dup)', Metas: [{ Key: 'BigCatalogId', Value: 'ID1' }] }, // dup id
          { Source: 'Game', Title: 'no id' }, // no BigCatalogId -> dropped
          { Source: 'Game', Metas: [{ Key: 'BigCatalogId', Value: 'ID2' }] }, // no title -> dropped
        ],
      },
    ],
  });
  assert.deepEqual(out, [{ providerId: 'ID1', title: 'A', thumbnail: null }]);
});

test('parseDetail maps a product to digital detail (players, long duration, xbox url)', () => {
  const d = xbox.parseDetail(DETAIL_JSON, '9N683TDT5M7R');
  assert.equal(d.provider, 'xbox');
  assert.equal(d.externalId, '9N683TDT5M7R');
  assert.equal(d.title, 'Halo: Campaign Evolved');
  assert.equal(d.type, 'digital');
  assert.equal(d.duration, 'long'); // Microsoft Store has no play-time; digital default
  assert.equal(d.minPlayers, 1); // SinglePlayer floors the minimum at 1
  assert.equal(d.maxPlayers, 4); // widest coop bound
  assert.equal(d.imageUrl, 'https://store-images.s-microsoft.com/image/boxart'); // BoxArt preferred
  assert.equal(d.url, 'https://www.xbox.com/de-de/games/store/_/9N683TDT5M7R');
});

test('parseDetail still returns a usable object for a missing product', () => {
  const d = xbox.parseDetail({}, '999');
  assert.equal(d.provider, 'xbox');
  assert.equal(d.externalId, '999');
  assert.equal(d.title, null);
  assert.equal(d.imageUrl, null);
  assert.equal(d.type, 'digital');
  assert.equal(d.duration, 'long');
  assert.equal(d.minPlayers, null);
  assert.equal(d.maxPlayers, null);
  assert.equal(d.url, 'https://www.xbox.com/de-de/games/store/_/999');
  // fully empty payload is still safe
  assert.equal(xbox.parseDetail(null, '999').title, null);
});

test('parsePlayers derives bounds from Xbox Live capability attributes', () => {
  // single-player only -> exactly 1
  assert.deepEqual(xbox.parsePlayers([{ Name: 'SinglePlayer' }]), { min: 1, max: 1 });
  // multiplayer without single-player: min from the attribute, max widest
  assert.deepEqual(
    xbox.parsePlayers([{ Name: 'XblOnlineMultiplayer', Minimum: 2, Maximum: 16 }]),
    { min: 2, max: 16 }
  );
  // single + coop: floor min at 1, take widest max
  assert.deepEqual(
    xbox.parsePlayers([{ Name: 'SinglePlayer' }, { Name: 'XblOnlineCoop', Minimum: 2, Maximum: 4 }]),
    { min: 1, max: 4 }
  );
  // unknown / no player attributes -> null bounds, never invented
  assert.deepEqual(xbox.parsePlayers([]), { min: null, max: null });
  assert.deepEqual(xbox.parsePlayers(null), { min: null, max: null });
  assert.deepEqual(xbox.parsePlayers([{ Name: 'CrossPlatformMultiplayer' }]), { min: null, max: null });
  // "0"/non-positive bounds are treated as unknown
  assert.deepEqual(xbox.parsePlayers([{ Name: 'XblLocalMultiplayer', Maximum: 0 }]), { min: null, max: null });
});

test('pickImage prefers box art then falls back through poster to any image', () => {
  assert.equal(
    xbox.pickImage([
      { ImagePurpose: 'Poster', Uri: '//img/poster' },
      { ImagePurpose: 'BoxArt', Uri: '//img/box' },
    ]),
    'https://img/box'
  );
  assert.equal(xbox.pickImage([{ ImagePurpose: 'Poster', Uri: '//img/poster' }]), 'https://img/poster');
  assert.equal(xbox.pickImage([{ ImagePurpose: 'Weird', Uri: 'https://img/other' }]), 'https://img/other');
  assert.equal(xbox.pickImage([]), null);
  assert.equal(xbox.pickImage(null), null);
});

test('imageHostAllowed only vouches for Microsoft store-image hosts', () => {
  assert.equal(xbox.imageHostAllowed('https://store-images.s-microsoft.com/image/x'), true);
  assert.equal(xbox.imageHostAllowed('https://evil.example.com/x.jpg'), false);
  assert.equal(xbox.imageHostAllowed('file:///etc/passwd'), false);
  assert.equal(xbox.imageHostAllowed('not a url'), false);
  // suffix-spoofing guard
  assert.equal(xbox.imageHostAllowed('https://s-microsoft.com.evil.com/x'), false);
});
