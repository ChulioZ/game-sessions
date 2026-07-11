'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computePlaces } = require('../public/js/ranking');

// Helper: build sorted-desc rows from a list of averages (all rated unless a
// count is given), mirroring what showResults passes in.
const rows = (...avgs) => avgs.map((avg) => ({ avg, count: 1 }));

test('no ties: places are 1, 2, 3, …', () => {
  assert.deepEqual(computePlaces(rows(5, 4, 3, 2)), [1, 2, 3, 4]);
});

test('standard competition ranking after a tie ("1, 2, 2, 4")', () => {
  assert.deepEqual(computePlaces(rows(5, 4, 4, 3)), [1, 2, 2, 4]);
});

test('multi-way tie for first (all crowned, all place 1)', () => {
  assert.deepEqual(computePlaces(rows(4, 4, 4)), [1, 1, 1]);
});

test('tie for third spills past the podium', () => {
  assert.deepEqual(computePlaces(rows(5, 4, 3, 3, 2)), [1, 2, 3, 3, 5]);
});

test('everyone tied', () => {
  assert.deepEqual(computePlaces(rows(3, 3, 3, 3)), [1, 1, 1, 1]);
});

test('ties are decided at the displayed one-decimal precision', () => {
  // 4.04 and 4.02 both render as "4.0" → same place; 4.06 renders "4.1".
  assert.deepEqual(computePlaces(rows(4.06, 4.04, 4.02)), [1, 2, 2]);
});

test('unrated rows (count 0) get no place and never medal', () => {
  const input = [
    { avg: 4, count: 2 },
    { avg: 0, count: 0 },
    { avg: 0, count: 0 },
  ];
  assert.deepEqual(computePlaces(input), [1, null, null]);
});

test('empty input', () => {
  assert.deepEqual(computePlaces([]), []);
});
