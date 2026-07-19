'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const steam = require('../lib/providers/steam');

// A storesearch response mixes full games (type 'app') with a bundle (type
// 'sub'), which must be filtered out.
const SEARCH_JSON = {
  total: 3,
  items: [
    {
      type: 'app',
      name: 'The Witcher 3: Wild Hunt',
      id: 292030,
      tiny_image: 'https://shared.akamai.steamstatic.com/apps/292030/capsule_231x87.jpg',
    },
    {
      type: 'sub', // bundle/package -> excluded
      name: 'The Witcher 3: Wild Hunt - Complete Edition',
      id: 124923,
      tiny_image: 'https://shared.akamai.steamstatic.com/subs/124923/capsule_231x87.jpg',
    },
    {
      type: 'app',
      name: 'Stardew Valley',
      id: 413150,
      tiny_image: 'https://shared.akamai.steamstatic.com/apps/413150/capsule_231x87.jpg',
    },
  ],
};

test('parseSearch keeps only full games (type app) with thumbnails', () => {
  const out = steam.parseSearch(SEARCH_JSON);
  assert.equal(out.length, 2); // the 'sub' bundle is filtered out
  assert.deepEqual(out[0], {
    providerId: '292030', // stringified appid
    title: 'The Witcher 3: Wild Hunt',
    thumbnail: 'https://shared.akamai.steamstatic.com/apps/292030/capsule_231x87.jpg',
  });
  assert.equal(out[1].title, 'Stardew Valley');
});

test('parseSearch respects the limit and tolerates a missing/empty payload', () => {
  assert.equal(steam.parseSearch(SEARCH_JSON, 1).length, 1);
  assert.deepEqual(steam.parseSearch({}), []);
  assert.deepEqual(steam.parseSearch(null), []);
  assert.deepEqual(steam.parseSearch({ items: 'nope' }), []);
});

test('parseSearch dedupes by appid and skips entries missing id or name', () => {
  const out = steam.parseSearch({
    items: [
      { type: 'app', id: 1, name: 'A' },
      { type: 'app', id: 1, name: 'A (dup)' }, // same appid -> dropped
      { type: 'app', id: 2 }, // no name -> dropped
      { type: 'app', name: 'no id' }, // no id -> dropped
    ],
  });
  assert.deepEqual(out, [{ providerId: '1', title: 'A', thumbnail: null }]);
});

test('parsePlayers infers counts from locale-independent category ids', () => {
  // Single-player only -> exactly one.
  assert.deepEqual(steam.parsePlayers([{ id: 2, description: 'Einzelspieler' }]), { min: 1, max: 1 });
  // Multi-player -> min 1, upper bound unknown (never invented).
  assert.deepEqual(steam.parsePlayers([{ id: 1, description: 'Mehrspieler' }]), { min: 1, max: null });
  // Co-op (id 9) also counts as multiplayer.
  assert.deepEqual(steam.parsePlayers([{ id: 2 }, { id: 9 }]), { min: 1, max: null });
  // Neither flag present -> unknown.
  assert.deepEqual(steam.parsePlayers([{ id: 22, description: 'Achievements' }]), { min: null, max: null });
  assert.deepEqual(steam.parsePlayers(null), { min: null, max: null });
});

test('pickImage prefers header_image then falls back to capsule_image', () => {
  assert.equal(steam.pickImage({ header_image: 'h', capsule_image: 'c' }), 'h');
  assert.equal(steam.pickImage({ capsule_image: 'c' }), 'c');
  assert.equal(steam.pickImage({}), null);
  assert.equal(steam.pickImage(null), null);
});

test('parseAppDetails maps a successful entry (digital, players)', () => {
  const json = {
    292030: {
      success: true,
      data: {
        type: 'game',
        name: 'The Witcher 3: Wild Hunt',
        header_image: 'https://shared.akamai.steamstatic.com/apps/292030/header.jpg',
        categories: [{ id: 2, description: 'Einzelspieler' }],
      },
    },
  };
  const d = steam.parseAppDetails(json, '292030');
  assert.equal(d.provider, 'steam');
  assert.equal(d.externalId, '292030');
  assert.equal(d.title, 'The Witcher 3: Wild Hunt');
  assert.equal(d.type, 'digital');
  assert.equal(d.minPlayers, 1);
  assert.equal(d.maxPlayers, 1);
  assert.equal(d.imageUrl, 'https://shared.akamai.steamstatic.com/apps/292030/header.jpg');
  assert.equal(d.url, 'https://store.steampowered.com/app/292030/');
});

test('parseAppDetails still returns a usable object for a failed/missing entry', () => {
  const d = steam.parseAppDetails({ 999: { success: false } }, '999');
  assert.equal(d.provider, 'steam');
  assert.equal(d.externalId, '999');
  assert.equal(d.title, null);
  assert.equal(d.imageUrl, null);
  assert.equal(d.type, 'digital');
  assert.equal(d.minPlayers, null);
  assert.equal(d.maxPlayers, null);
  assert.equal(d.url, 'https://store.steampowered.com/app/999/');
  // fully empty payload is still safe
  assert.equal(steam.parseAppDetails(null, '999').title, null);
});

test('imageHostAllowed only vouches for Steam CDN hosts', () => {
  assert.equal(steam.imageHostAllowed('https://shared.akamai.steamstatic.com/x.jpg'), true);
  assert.equal(steam.imageHostAllowed('https://cdn.cloudflare.steamstatic.com/x.jpg'), true);
  assert.equal(steam.imageHostAllowed('https://steamstatic.com/x.jpg'), true);
  assert.equal(steam.imageHostAllowed('https://evil.example.com/x.jpg'), false);
  assert.equal(steam.imageHostAllowed('file:///etc/passwd'), false);
  assert.equal(steam.imageHostAllowed('not a url'), false);
  // suffix-spoofing guard
  assert.equal(steam.imageHostAllowed('https://steamstatic.com.evil.com/x'), false);
});
