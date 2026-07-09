'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { store, DATA_DIR } = require('./helpers');

test('id() produces unique 16-char hex ids', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => store.id()));
  assert.equal(ids.size, 1000);
  for (const value of ids) assert.match(value, /^[0-9a-f]{16}$/);
});

test('pushActivity creates the array and stamps id/at/type', () => {
  const round = {};
  store.pushActivity(round, 'game_added', { title: 'Chess' });
  assert.equal(round.activities.length, 1);
  const entry = round.activities[0];
  assert.equal(entry.type, 'game_added');
  assert.equal(entry.title, 'Chess');
  assert.ok(entry.id);
  assert.ok(!Number.isNaN(Date.parse(entry.at)));
});

test('saveData writes valid JSON atomically (no leftover temp file)', () => {
  store.saveData();
  const file = path.join(DATA_DIR, 'data.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(parsed.rounds));
  assert.ok(!fs.existsSync(file + '.tmp'));
});

test('findRound looks a round up by id', () => {
  const round = { id: store.id(), name: 'Lookup', members: [], games: [], sessions: [] };
  store.data.rounds.push(round);
  assert.equal(store.findRound(round.id), round);
  assert.equal(store.findRound('missing'), undefined);
});
