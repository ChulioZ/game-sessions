'use strict';

/* Unit tests for the pure stale-while-revalidate store (public/js/swr.js) that
 * backs the navigation cache in core.js. Pure module, injectable clock and
 * storage — no DOM, no network. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSwrStore } = require('../public/js/swr');

// Minimal Web-Storage stand-in; `throwOnSet` models a full/private-mode quota.
function fakeStorage(initial = {}, { throwOnSet = false } = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (throwOnSet) throw new Error('quota'); m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

function clock(start = 1000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('get/set round-trips values and persists them across store instances', () => {
  const storage = fakeStorage();
  const a = createSwrStore({ storage, storageKey: 'k' });
  assert.equal(a.get('rounds'), undefined);
  a.set('rounds', [{ id: 'r1' }]);
  assert.deepEqual(a.get('rounds'), [{ id: 'r1' }]);

  // A second store over the same storage (= a page reload) sees the data.
  const b = createSwrStore({ storage, storageKey: 'k' });
  assert.deepEqual(b.get('rounds'), [{ id: 'r1' }]);
});

test('clear empties memory AND the persisted copy', () => {
  const storage = fakeStorage();
  const store = createSwrStore({ storage, storageKey: 'k' });
  store.set('a', 1);
  store.clear();
  assert.equal(store.get('a'), undefined);
  assert.equal(storage.getItem('k'), null);
  const reloaded = createSwrStore({ storage, storageKey: 'k' });
  assert.equal(reloaded.get('a'), undefined);
});

test('corrupted or foreign-shaped persisted JSON degrades to an empty store', () => {
  for (const raw of ['not json{', '"just a string"', '[]', JSON.stringify({ nope: 1 })]) {
    const store = createSwrStore({ storage: fakeStorage({ k: raw }), storageKey: 'k' });
    assert.equal(store.get('anything'), undefined, `raw: ${raw}`);
    store.set('x', 1); // and it keeps working
    assert.equal(store.get('x'), 1);
  }
});

test('a throwing storage degrades to memory-only, silently', () => {
  const store = createSwrStore({ storage: fakeStorage({}, { throwOnSet: true }), storageKey: 'k' });
  store.set('a', 42); // must not throw
  assert.equal(store.get('a'), 42);
  store.clear();
  assert.equal(store.get('a'), undefined);
});

test('eviction drops the oldest entries beyond maxEntries', () => {
  const now = clock();
  const store = createSwrStore({ storage: null, maxEntries: 3, now });
  for (const k of ['a', 'b', 'c']) { store.set(k, k); now.advance(10); }
  store.set('d', 'd'); // over the bound -> 'a' (oldest) goes
  assert.equal(store.get('a'), undefined);
  assert.equal(store.get('b'), 'b');
  assert.equal(store.get('d'), 'd');
  // Re-setting refreshes an entry's age, so it survives the next eviction.
  store.set('b', 'b2'); now.advance(10);
  store.set('e', 'e'); // 'c' is now the oldest
  assert.equal(store.get('c'), undefined);
  assert.equal(store.get('b'), 'b2');
});

test('beginRevalidate: fresh entries and in-flight keys refuse; stale ones fetch once', () => {
  const now = clock();
  const store = createSwrStore({ storage: null, now });

  // Unknown key: revalidate (the caller decides to block-fetch instead, but
  // the answer must not dead-lock a miss).
  assert.equal(store.beginRevalidate('miss', 5000), true);
  store.endRevalidate('miss');

  store.set('r', { v: 1 });
  // Younger than the freshness window -> no refetch (this is also the
  // re-render loop breaker: the re-rendered view re-reads within the window).
  assert.equal(store.beginRevalidate('r', 5000), false);

  now.advance(5001);
  assert.equal(store.beginRevalidate('r', 5000), true, 'stale -> fetch');
  // ...but only once while that fetch is in flight.
  assert.equal(store.beginRevalidate('r', 5000), false, 'in flight -> refuse');

  // A FAILED fetch (endRevalidate without set) leaves the entry stale, so the
  // next read simply tries again.
  store.endRevalidate('r');
  assert.equal(store.beginRevalidate('r', 5000), true);
  store.endRevalidate('r');

  // A successful fetch (set + endRevalidate) restarts the freshness window.
  store.set('r', { v: 2 });
  store.endRevalidate('r');
  assert.equal(store.beginRevalidate('r', 5000), false);
});
