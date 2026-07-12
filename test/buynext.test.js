'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { playNextRecommendations } = require('../public/js/buynext');

// Build a { gameId: stats } map from a compact spec, mirroring what
// gameStats(round, id) returns for each active game.
const statsMap = (spec) => {
  const m = {};
  for (const [id, st] of Object.entries(spec)) m[id] = st;
  return m;
};
const games = (...ids) => ids.map((id) => ({ id, title: id, type: 'analog' }));

test('thin data (below the vote gate) surfaces nothing', () => {
  const active = games('a');
  const stats = statsMap({ a: { avg: 5, sessions: 1, votesCast: 2 } });
  assert.deepEqual(playNextRecommendations(active, stats, 6), []);
});

test('a highly-rated, under-played game is surfaced', () => {
  const active = games('loved');
  const stats = statsMap({ loved: { avg: 4.6, sessions: 1, votesCast: 8 } });
  const recs = playNextRecommendations(active, stats, 6);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].game.id, 'loved');
});

test('low-rated games are not surfaced', () => {
  const active = games('meh');
  const stats = statsMap({ meh: { avg: 3.2, sessions: 1, votesCast: 8 } });
  assert.deepEqual(playNextRecommendations(active, stats, 6), []);
});

test('games with no ratings (avg null) are ignored', () => {
  const active = games('unrated');
  const stats = statsMap({ unrated: { avg: null, sessions: 0, votesCast: 8 } });
  assert.deepEqual(playNextRecommendations(active, stats, 6), []);
});

test('least-played loved game ranks first; ties break by higher average', () => {
  const active = games('often', 'rare', 'rareLoved');
  const stats = statsMap({
    often: { avg: 4.2, sessions: 5, votesCast: 10 },
    rare: { avg: 4.1, sessions: 1, votesCast: 10 },
    rareLoved: { avg: 4.9, sessions: 1, votesCast: 10 },
  });
  const recs = playNextRecommendations(active, stats, 6);
  assert.deepEqual(recs.map((r) => r.game.id), ['rareLoved', 'rare', 'often']);
});

test('a game absent from the stats map is skipped without throwing', () => {
  const active = games('a', 'ghost');
  const stats = statsMap({ a: { avg: 4.5, sessions: 1, votesCast: 8 } });
  const recs = playNextRecommendations(active, stats, 6);
  assert.deepEqual(recs.map((r) => r.game.id), ['a']);
});
