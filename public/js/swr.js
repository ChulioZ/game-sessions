/* Spielwirbel – stale-while-revalidate cache store (pure, no DOM).
   Backs the navigation cache in core.js: views render instantly from the last
   known data (persisted across reloads) while a background fetch brings them
   up to date. This file is deliberately dependency-free and side-effect-free —
   core.js constructs the store — so the test suite can require it directly
   (see .claude/rules/frontend-helper-modules-and-coverage.md).
   Part of the frontend; all files share one global script scope. */

'use strict';

// A tiny key -> { v (value), at (ms of last successful fetch) } store with
// optional Web-Storage persistence and oldest-first eviction.
//
//   opts.storage    Web-Storage-like ({ getItem, setItem, removeItem }) or null
//                   for memory-only. Every access is guarded: quota errors,
//                   private-mode refusals and corrupted JSON all degrade to
//                   memory-only silently — the cache is an accelerator, never
//                   a dependency.
//   opts.storageKey Key the whole store persists under.
//   opts.maxEntries Eviction bound (default 12): a round payload is tens of KB,
//                   so an unbounded store could crowd the storage quota.
//   opts.now        Clock, injectable for tests (default Date.now).
//
// Revalidation bookkeeping lives here too, so callers can't double-fetch:
// beginRevalidate(key, freshMs) answers "should the caller fetch now?" — false
// while a fetch for the key is in flight OR the entry is younger than freshMs
// (which is also what stops a re-render loop: the re-rendered view re-reads the
// just-refreshed key and gets `false`). endRevalidate(key) clears the in-flight
// mark; on a failed fetch the entry's age is untouched, so the next read past
// the freshness window simply tries again.
function createSwrStore(opts) {
  const storage = opts.storage || null;
  const storageKey = opts.storageKey || 'swr';
  const maxEntries = opts.maxEntries || 12;
  const now = opts.now || Date.now;
  const fetching = new Set();

  let entries = {};
  if (storage) {
    try {
      const raw = storage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      // Only accept the exact persisted shape; anything else starts empty.
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        entries = parsed.entries;
      }
    } catch { /* corrupted or inaccessible -> memory-only */ }
  }

  function persist() {
    if (!storage) return;
    try {
      storage.setItem(storageKey, JSON.stringify({ entries }));
    } catch { /* quota/private mode -> keep serving from memory */ }
  }

  function get(key) {
    const e = entries[key];
    return e ? e.v : undefined;
  }

  function set(key, value) {
    entries[key] = { v: value, at: now() };
    const keys = Object.keys(entries);
    if (keys.length > maxEntries) {
      keys.sort((a, b) => entries[a].at - entries[b].at);
      for (const k of keys.slice(0, keys.length - maxEntries)) delete entries[k];
    }
    persist();
  }

  function clear() {
    entries = {};
    fetching.clear();
    if (storage) {
      try { storage.removeItem(storageKey); } catch { /* ignore */ }
    }
  }

  function beginRevalidate(key, freshMs) {
    if (fetching.has(key)) return false;
    const e = entries[key];
    if (e && now() - e.at < freshMs) return false;
    fetching.add(key);
    return true;
  }

  function endRevalidate(key) {
    fetching.delete(key);
  }

  return { get, set, clear, beginRevalidate, endRevalidate };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createSwrStore };
}
