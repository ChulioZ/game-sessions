'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const nintendo = require('../lib/providers/nintendo');

// A Solr search response: docs carry fs_id, title, player counts, cover images
// and a store path — everything the lookup needs in one hop.
const SEARCH_JSON = {
  response: {
    numFound: 2,
    docs: [
      {
        fs_id: '70010000000126',
        title: 'The Legend of Zelda: Breath of the Wild',
        url: '/de-de/Spiele/Nintendo-Switch-Spiele/zelda-1234.html',
        players_from: 1,
        players_to: 1,
        image_url: 'https://www.nintendo.com/eu/media/images/zelda_primary.jpg',
        image_url_sq_s: 'https://www.nintendo.com/eu/media/images/zelda_square.jpg',
        image_url_h2x1_s: 'https://www.nintendo.com/eu/media/images/zelda_wide.jpg',
      },
      {
        fs_id: '70010000000153',
        title: 'Mario Kart 8 Deluxe',
        url: '/de-de/Spiele/Nintendo-Switch-Spiele/mk8-5678.html',
        players_from: 1,
        players_to: 8,
        image_url_sq_s: 'https://www.nintendo.com/eu/media/images/mk8_square.jpg',
      },
    ],
  },
};

test('parseSearch maps docs to normalized results with a cover thumbnail', () => {
  const out = nintendo.parseSearch(SEARCH_JSON);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    providerId: '70010000000126',
    title: 'The Legend of Zelda: Breath of the Wild',
    thumbnail: 'https://www.nintendo.com/eu/media/images/zelda_square.jpg', // square preferred
  });
  assert.equal(out[1].title, 'Mario Kart 8 Deluxe');
});

test('parseSearch respects the limit and tolerates a missing/empty payload', () => {
  assert.equal(nintendo.parseSearch(SEARCH_JSON, 1).length, 1);
  assert.deepEqual(nintendo.parseSearch({}), []);
  assert.deepEqual(nintendo.parseSearch(null), []);
  assert.deepEqual(nintendo.parseSearch({ response: { docs: 'nope' } }), []);
});

test('parseSearch dedupes by fs_id and skips entries missing id or title', () => {
  const out = nintendo.parseSearch({
    response: {
      docs: [
        { fs_id: 1, title: 'A' },
        { fs_id: 1, title: 'A (dup)' }, // same fs_id -> dropped
        { fs_id: 2 }, // no title -> dropped
        { title: 'no id' }, // no fs_id -> dropped
      ],
    },
  });
  assert.deepEqual(out, [{ providerId: '1', title: 'A', thumbnail: null }]);
});

test('parseDetail maps a doc to digital detail (players, store url)', () => {
  const d = nintendo.parseDetail(SEARCH_JSON, '70010000000126');
  assert.equal(d.provider, 'nintendo');
  assert.equal(d.externalId, '70010000000126');
  assert.equal(d.title, 'The Legend of Zelda: Breath of the Wild');
  assert.equal(d.type, 'digital');
  assert.equal(d.minPlayers, 1);
  assert.equal(d.maxPlayers, 1);
  assert.equal(d.imageUrl, 'https://www.nintendo.com/eu/media/images/zelda_square.jpg');
  assert.equal(d.url, 'https://www.nintendo.com/de-de/Spiele/Nintendo-Switch-Spiele/zelda-1234.html');
});

test('parseDetail treats "0"/unknown player counts as null', () => {
  const d = nintendo.parseDetail(
    { response: { docs: [{ fs_id: '9', title: 'X', url: '/de-de/x.html', players_from: 0, players_to: 0 }] } },
    '9'
  );
  assert.equal(d.minPlayers, null);
  assert.equal(d.maxPlayers, null);
});

test('parseDetail still returns a usable object for an empty result set', () => {
  const d = nintendo.parseDetail({ response: { docs: [] } }, '999');
  assert.equal(d.provider, 'nintendo');
  assert.equal(d.externalId, '999');
  assert.equal(d.title, null);
  assert.equal(d.imageUrl, null);
  assert.equal(d.type, 'digital');
  assert.equal(d.minPlayers, null);
  assert.equal(d.maxPlayers, null);
  assert.equal(d.url, 'https://www.nintendo.com'); // no path -> store home fallback
  // fully empty payload is still safe
  assert.equal(nintendo.parseDetail(null, '999').title, null);
});

test('pickImage prefers the square cover then falls back to primary and wide', () => {
  assert.equal(nintendo.pickImage({ image_url_sq_s: 'sq', image_url: 'p', image_url_h2x1_s: 'w' }), 'sq');
  assert.equal(nintendo.pickImage({ image_url: 'p', image_url_h2x1_s: 'w' }), 'p');
  assert.equal(nintendo.pickImage({ image_url_h2x1_s: 'w' }), 'w');
  assert.equal(nintendo.pickImage({}), null);
  assert.equal(nintendo.pickImage(null), null);
});

test('imageHostAllowed only vouches for Nintendo image hosts', () => {
  assert.equal(nintendo.imageHostAllowed('https://www.nintendo.com/eu/media/images/x.jpg'), true);
  assert.equal(nintendo.imageHostAllowed('https://nintendo.com/x.jpg'), true);
  assert.equal(nintendo.imageHostAllowed('https://evil.example.com/x.jpg'), false);
  assert.equal(nintendo.imageHostAllowed('file:///etc/passwd'), false);
  assert.equal(nintendo.imageHostAllowed('not a url'), false);
  // suffix-spoofing guard
  assert.equal(nintendo.imageHostAllowed('https://nintendo.com.evil.com/x'), false);
});
