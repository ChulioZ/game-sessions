/* Spielwirbel – lookup grouping: collapse same-title provider hits into one row.
   Pure and dependency-free, so it works both as a shared-scope frontend script
   (browser global) and as a CommonJS module the test suite can require. Load
   order: see index.html (before views-round.js). */

'use strict';

// Group merged provider hits by normalized title (trim + lowercase — the same
// normalization scoreHit applies, so no fuzzy/edit-distance matching) into one
// row per game. Each hit carries { provider, title, thumbnail, score, prio,
// order } (prio = LOOKUP_PROVIDERS priority, order = the provider's own order).
//
// Returns an array of groups, each:
//   { key, title, thumbnail, primary, members }
// - members: one hit per contributing provider (the strongest per provider),
//   ordered by provider priority — one badge each.
// - primary: the highest-priority provider's hit (drives the row title/thumb and
//   the title-click pick).
// - title: the primary provider's display title (casing may differ per provider).
// - thumbnail: the highest-priority member that has a thumbnail (else null).
//
// Groups are ranked by their *best* member (max score, then best priority, then
// earliest order), so a game's row rank is its strongest provider's rank. When
// `max` is a number the result is sliced to that many groups (rows).
function groupLookupHits(hits, max) {
  // Relevance order (best first): score desc, then provider priority, then the
  // provider's own order. Priority/badge order ignores score (pure priority).
  const byRelevance = (a, b) => b.score - a.score || a.prio - b.prio || a.order - b.order;
  const byPrio = (a, b) => a.prio - b.prio || a.order - b.order;

  const groups = new Map();
  (hits || []).forEach((hit) => {
    const key = (hit.title || '').trim().toLowerCase();
    if (!key) return;
    let g = groups.get(key);
    if (!g) { g = new Map(); groups.set(key, g); }
    // Keep only the strongest hit per provider, so each provider yields exactly
    // one badge even if it (or a re-render) contributed the title twice.
    const prev = g.get(hit.provider);
    if (!prev || byRelevance(hit, prev) < 0) g.set(hit.provider, hit);
  });

  const result = [];
  groups.forEach((byProvider, key) => {
    const members = Array.from(byProvider.values()).sort(byPrio);
    const best = members.slice().sort(byRelevance)[0];
    const withThumb = members.find((m) => m.thumbnail);
    result.push({
      key,
      title: members[0].title, // the highest-priority member's title
      thumbnail: withThumb ? withThumb.thumbnail : null,
      primary: members[0],
      members,
      best,
    });
  });

  result.sort((a, b) =>
    b.best.score - a.best.score || a.best.prio - b.best.prio || a.best.order - b.best.order);
  return typeof max === 'number' ? result.slice(0, max) : result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { groupLookupHits };
}
