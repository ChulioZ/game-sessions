'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { groupLookupHits } = require('../public/js/lookup-group');

// Build a hit the way attachLookup's render() does: score/prio/order plus the
// provider payload. prio mirrors LOOKUP_PROVIDERS priority (lower = higher).
const hit = (provider, title, { score = 5, prio = 0, order = 0, thumbnail = null, providerId } = {}) =>
  ({ provider, title, providerId: providerId || `${provider}-id`, thumbnail, score, prio, order });

test('distinct titles stay as separate one-provider rows', () => {
  const groups = groupLookupHits([
    hit('psstore', 'Hades', { prio: 0 }),
    hit('steam', 'Celeste', { prio: 2 }),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.title), ['Hades', 'Celeste']);
  assert.deepEqual(groups.map((g) => g.members.length), [1, 1]);
});

test('same normalized title from two providers collapses into one row', () => {
  const groups = groupLookupHits([
    hit('psstore', 'Hades', { prio: 0 }),
    hit('steam', 'hades ', { prio: 2 }), // differs only by case + trailing space
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 2);
});

test('badges are ordered by provider priority; primary is the highest-priority hit', () => {
  const groups = groupLookupHits([
    hit('steam', 'Hades', { prio: 2, score: 5 }),   // arrives first but lower prio
    hit('psstore', 'Hades', { prio: 0, score: 4 }), // higher priority (lower prio)
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((m) => m.provider), ['psstore', 'steam']);
  assert.equal(groups[0].primary.provider, 'psstore');
  assert.equal(groups[0].title, 'Hades'); // primary's display title
});

test('title/thumbnail: primary title, thumbnail from the highest-priority hit that has one', () => {
  const groups = groupLookupHits([
    hit('psstore', 'Hades', { prio: 0, thumbnail: null }),
    hit('steam', 'Hades', { prio: 2, thumbnail: 'https://cdn/steam.jpg' }),
  ]);
  assert.equal(groups[0].primary.provider, 'psstore');
  assert.equal(groups[0].thumbnail, 'https://cdn/steam.jpg'); // psstore had none
});

test('groups are ranked by their best member, not by the primary', () => {
  // "Zelda" only from a strong (score 5) lower-priority steam hit should outrank
  // "Aladdin" whose best member scores 3, even though Aladdin has prio-0 psstore.
  const groups = groupLookupHits([
    hit('psstore', 'Aladdin', { prio: 0, score: 3 }),
    hit('steam', 'Zelda', { prio: 2, score: 5 }),
  ]);
  assert.deepEqual(groups.map((g) => g.title), ['Zelda', 'Aladdin']);
});

test('best-member ranking beats a weaker exact-priority row', () => {
  // Group A: psstore score 4 + steam score 5 → best score 5.
  // Group B: psstore score 4 only. A should rank above B.
  const groups = groupLookupHits([
    hit('psstore', 'B Game', { prio: 0, score: 4 }),
    hit('psstore', 'A Game', { prio: 0, score: 4 }),
    hit('steam', 'A Game', { prio: 2, score: 5 }),
  ]);
  assert.equal(groups[0].title, 'A Game');
});

test('max limits the number of rows (groups), not raw hits', () => {
  const hits = [
    hit('psstore', 'One', { prio: 0, score: 5, order: 0 }),
    hit('steam', 'One', { prio: 2, score: 5, order: 0 }),
    hit('psstore', 'Two', { prio: 0, score: 4, order: 1 }),
    hit('psstore', 'Three', { prio: 0, score: 3, order: 2 }),
  ];
  const groups = groupLookupHits(hits, 2);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.title), ['One', 'Two']);
});

test('duplicate hits from the same provider yield a single badge (strongest kept)', () => {
  const groups = groupLookupHits([
    hit('psstore', 'Hades', { prio: 0, score: 3, order: 5, providerId: 'weak' }),
    hit('psstore', 'Hades', { prio: 0, score: 5, order: 0, providerId: 'strong' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 1);
  assert.equal(groups[0].members[0].providerId, 'strong');
  assert.equal(groups[0].primary.providerId, 'strong');
});

test('empty / whitespace-only titles are dropped', () => {
  const groups = groupLookupHits([
    hit('psstore', '   ', { prio: 0 }),
    hit('steam', 'Real', { prio: 2 }),
  ]);
  assert.deepEqual(groups.map((g) => g.title), ['Real']);
});

test('no hits → no groups; omitting max returns every group', () => {
  assert.deepEqual(groupLookupHits([]), []);
  assert.deepEqual(groupLookupHits(undefined), []);
  const many = Array.from({ length: 15 }, (_, i) =>
    hit('psstore', `G${String(i).padStart(2, '0')}`, { prio: 0, score: 5, order: i }));
  assert.equal(groupLookupHits(many).length, 15);
});
