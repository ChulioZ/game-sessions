'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bgg = require('../lib/providers/bgg');

// --- buildSparql ---------------------------------------------------------

test('buildSparql embeds the (escaped) query, the P2339 filter and the limit', () => {
  const q = bgg.buildSparql('catan', 5);
  assert.match(q, /mwapi:srsearch "catan haswbstatement:P2339"/);
  assert.match(q, /wdt:P2339 \?bgg/);
  assert.match(q, /LIMIT 5$/);
});

test('buildSparql escapes quotes and backslashes so a typed quote cannot break the query', () => {
  const q = bgg.buildSparql('a"b\\c');
  // The literal must stay a single well-formed SPARQL string.
  assert.match(q, /mwapi:srsearch "a\\"b\\\\c haswbstatement:P2339"/);
});

test('buildSparql embeds the requested wikibase:language (preferred first, other as fallback)', () => {
  assert.match(bgg.buildSparql('catan', 8, 'de'), /wikibase:language "de,en"/);
  assert.match(bgg.buildSparql('catan', 8, 'en'), /wikibase:language "en,de"/);
  // Defaults to en-first when no locale is given.
  assert.match(bgg.buildSparql('catan'), /wikibase:language "en,de"/);
  // A non-2-letter/injection-y value falls back to en (no raw value leaks in).
  assert.match(bgg.buildSparql('catan', 8, 'de"} evil'), /wikibase:language "en,de"/);
});

// --- buildLabelSparql / parseLabel (localized saved title on pick) --------

test('buildLabelSparql resolves the P2339 entity label in the requested language', () => {
  const q = bgg.buildLabelSparql('13', 'de');
  assert.match(q, /wdt:P2339 "13"/);
  assert.match(q, /wikibase:language "de,en"/);
  assert.match(q, /LIMIT 1$/);
  // en-first by default, and the id is escaped like the search query.
  assert.match(bgg.buildLabelSparql('13'), /wikibase:language "en,de"/);
  assert.match(bgg.buildLabelSparql('a"b'), /wdt:P2339 "a\\"b"/);
});

test('parseLabel returns the label, or null for a missing/Q-id placeholder', () => {
  const wdqs = (v) => ({ results: { bindings: v === undefined ? [] : [{ itemLabel: { value: v } }] } });
  assert.equal(bgg.parseLabel(wdqs('Die Siedler von Catan')), 'Die Siedler von Catan');
  assert.equal(bgg.parseLabel(wdqs('Q13')), null); // unresolved label -> null
  assert.equal(bgg.parseLabel(wdqs()), null); // no rows
  assert.equal(bgg.parseLabel(null), null);
  assert.equal(bgg.parseLabel({}), null);
});

// --- parseSearch ---------------------------------------------------------

function wdqs(rows) {
  return { results: { bindings: rows } };
}
const row = (bggId, label) => ({
  item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${bggId}` },
  bgg: { type: 'literal', value: String(bggId) },
  itemLabel: { 'xml:lang': 'en', type: 'literal', value: label },
});

test('parseSearch normalizes bindings to { providerId, title, thumbnail:null }', () => {
  const out = bgg.parseSearch(wdqs([row(13, 'Catan'), row(266192, 'Wingspan')]));
  assert.deepEqual(out, [
    { providerId: '13', title: 'Catan', thumbnail: null },
    { providerId: '266192', title: 'Wingspan', thumbnail: null },
  ]);
});

test('parseSearch dedupes by BGG id and drops label-less (Q-id) or non-numeric rows', () => {
  const out = bgg.parseSearch(
    wdqs([
      row(13, 'Catan'),
      row(13, 'Catan (duplicate)'), // same BGG id -> dropped
      row(99, 'Q99'), // unresolved label -> dropped
      { bgg: { value: 'not-a-number' }, itemLabel: { value: 'Junk' } }, // bad id -> dropped
    ])
  );
  assert.deepEqual(out, [{ providerId: '13', title: 'Catan', thumbnail: null }]);
});

test('parseSearch respects the limit and tolerates a malformed response', () => {
  assert.equal(bgg.parseSearch(wdqs([row(1, 'A'), row(2, 'B'), row(3, 'C')]), 2).length, 2);
  assert.deepEqual(bgg.parseSearch(null), []);
  assert.deepEqual(bgg.parseSearch({}), []);
});

// --- parseProduct --------------------------------------------------------

const CATAN = {
  item: {
    name: 'Catan',
    minplayers: '3',
    maxplayers: '4',
    minplaytime: '60',
    maxplaytime: '120',
    imageurl: 'https://cf.geekdo-images.com/abc__itemrep/img/x/pic9156909.png',
    images: { thumb: 'https://cf.geekdo-images.com/abc__small/img/y/pic9156909.png' },
    canonical_link: 'https://boardgamegeek.com/boardgame/13/catan',
    subtype: 'boardgame',
  },
};

test('parseProduct normalizes a BGG item (analog, players, bucketed duration, cover, url)', () => {
  const d = bgg.parseProduct(CATAN, '13');
  assert.deepEqual(d, {
    provider: 'bgg',
    externalId: '13',
    title: 'Catan',
    minPlayers: 3,
    maxPlayers: 4,
    type: 'analog',
    duration: 'long', // avg(60,120) = 90 -> long
    imageUrl: 'https://cf.geekdo-images.com/abc__itemrep/img/x/pic9156909.png',
    url: 'https://boardgamegeek.com/boardgame/13/catan',
  });
});

test('parseProduct falls back to a constructed BGG url and never throws on a missing item', () => {
  const d = bgg.parseProduct({ item: null }, '13');
  assert.equal(d.provider, 'bgg');
  assert.equal(d.title, null);
  assert.equal(d.minPlayers, null);
  assert.equal(d.type, 'analog');
  assert.equal(d.duration, null);
  assert.equal(d.imageUrl, null);
  assert.equal(d.url, 'https://boardgamegeek.com/boardgame/13');
  // A totally empty response is handled the same way.
  assert.equal(bgg.parseProduct(null, '7').url, 'https://boardgamegeek.com/boardgame/7');
});

test('parseProduct treats BGG "0"/unknown numbers as null', () => {
  const d = bgg.parseProduct({ item: { name: 'X', minplayers: '0', maxplayers: '0', minplaytime: '0', maxplaytime: '0' } }, '1');
  assert.equal(d.minPlayers, null);
  assert.equal(d.maxPlayers, null);
  assert.equal(d.duration, null);
});

// --- bucketDuration ------------------------------------------------------

test('bucketDuration maps average play time to short/medium/long', () => {
  assert.equal(bgg.bucketDuration(10, 20), 'short'); // avg 15
  assert.equal(bgg.bucketDuration(20, 40), 'medium'); // avg 30 (boundary -> medium)
  assert.equal(bgg.bucketDuration(40, 70), 'medium'); // avg 55
  assert.equal(bgg.bucketDuration(60, 60), 'medium'); // avg 60 (boundary -> medium)
  assert.equal(bgg.bucketDuration(60, 120), 'long'); // avg 90
  assert.equal(bgg.bucketDuration('45', undefined), 'medium'); // single value, string
  assert.equal(bgg.bucketDuration(0, 0), null);
  assert.equal(bgg.bucketDuration(undefined, undefined), null);
});

// --- pickImage -----------------------------------------------------------

test('pickImage prefers the full image, falls back to medium/thumb, else null', () => {
  assert.equal(bgg.pickImage({ imageurl: 'A', images: { medium: 'B' } }), 'A');
  assert.equal(bgg.pickImage({ images: { medium: 'B', thumb: 'C' } }), 'B');
  assert.equal(bgg.pickImage({ images: { thumb: 'C' } }), 'C');
  assert.equal(bgg.pickImage({}), null);
  assert.equal(bgg.pickImage(null), null);
});

// --- imageHostAllowed (SSRF guard) --------------------------------------

test('imageHostAllowed accepts BGG image hosts and rejects everything else', () => {
  assert.equal(bgg.imageHostAllowed('https://cf.geekdo-images.com/x/pic.png'), true);
  assert.equal(bgg.imageHostAllowed('https://geekdo-images.com/x/pic.png'), true);
  assert.equal(bgg.imageHostAllowed('https://sub.geekdo-images.com/x/pic.png'), true);
  assert.equal(bgg.imageHostAllowed('https://evil.com/x.png'), false);
  assert.equal(bgg.imageHostAllowed('https://notgeekdo-images.com/x.png'), false);
  assert.equal(bgg.imageHostAllowed('file:///etc/passwd'), false);
  assert.equal(bgg.imageHostAllowed('not a url'), false);
});
