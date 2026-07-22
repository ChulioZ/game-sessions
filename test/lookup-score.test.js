'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scoreHit, foldTitle } = require('../public/js/lookup-score');
const { groupLookupHits } = require('../public/js/lookup-group');

// The reported repro (#317): the query carries a stray " - " the title spells
// as ":", so the whitespace split used to yield a dead "-" token that no word
// can start with — failing the loose tier and scoring the correct game 0.
const REPRO_Q = 'Die Quacksalber Von Quedlinburg - Megabox';
const REPRO_TITLE = 'Die Quacksalber von Quedlinburg: Die Megabox';

test('a query whose punctuation differs from the title still matches (#317)', () => {
  assert.ok(scoreHit(REPRO_TITLE, REPRO_Q) > 0);
});

test('the punctuated query outranks an unrelated title', () => {
  const unrelated = scoreHit('Perlen von Atlantis', REPRO_Q);
  assert.equal(unrelated, 0);
  assert.ok(scoreHit(REPRO_TITLE, REPRO_Q) > unrelated);
});

test('a punctuated hit sorts above an unrelated higher-priority provider hit', () => {
  // prio 0 = psstore, prio 1 = bgg (LOOKUP_PROVIDERS order). Before the fix
  // both scored 0, so provider priority alone put the wrong row first.
  const hit = (provider, title, prio) =>
    ({ provider, title, providerId: `${provider}-1`, thumbnail: null,
      score: scoreHit(title, REPRO_Q), prio, order: 0 });
  const groups = groupLookupHits([
    hit('psstore', 'Perlen von Atlantis', 0),
    hit('psstore', 'Die magische Wippe', 0),
    hit('bgg', REPRO_TITLE, 1),
  ]);
  assert.equal(groups[0].title, REPRO_TITLE);
});

test('the tiers are unchanged for a query without punctuation', () => {
  assert.equal(scoreHit('Hades', 'hades'), 5); // exact
  assert.equal(scoreHit('Hades II', 'hades'), 4); // starts with
  assert.equal(scoreHit('Return to Hades', 'hades'), 3); // word boundary
  assert.equal(scoreHit('Shadowgate', 'adowg'), 2); // substring
  assert.equal(scoreHit('Die Siedler von Catan', 'catan siedler'), 1); // loose
  assert.equal(scoreHit('Celeste', 'hades'), 0); // no match
});

test('empty / missing input scores 0 rather than throwing', () => {
  assert.equal(scoreHit('', 'hades'), 0);
  assert.equal(scoreHit('Hades', ''), 0);
  assert.equal(scoreHit(null, undefined), 0);
  assert.equal(scoreHit('...', 'hades'), 0); // folds to an empty title
});

test('a query that is only punctuation cannot match everything', () => {
  // It folds to '', so it must score 0 — not sail through the loose tier on an
  // empty token list.
  assert.equal(scoreHit('Hades', ' - : , '), 0);
});

test('foldTitle folds case, diacritics, ß and punctuation runs', () => {
  assert.equal(foldTitle('  Café  International!  '), 'cafe international');
  assert.equal(foldTitle('Straße des Ruhms'), 'strasse des ruhms');
  assert.equal(foldTitle('Catan: Seafarers - 5/6 Player'), 'catan seafarers 5 6 player');
});

test('foldTitle keeps non-Latin scripts instead of stripping them', () => {
  // Stripping whole scripts would fold this to a bare "catan" and make it
  // match far too much — same reasoning as norm() in lib/providers/bgg.js.
  assert.equal(foldTitle('Catan Двубоят'), 'catan двубоят');
});

test('diacritics fold in both directions', () => {
  assert.ok(scoreHit('Café International', 'cafe international') > 0);
  assert.ok(scoreHit('Cafe International', 'café international') > 0);
});
