/* Spieleabend – lookup grouping: collapse same-title provider hits into one row.
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
//
// `preferredProvider` (optional, e.g. the platform's own store when linking a
// game from its detail page — see showLinkProvider) biases the ranking without
// hard-partitioning the list: the preferred provider's single overall-best hit
// is pinned to row #1, its other hits win score ties over rival providers (but a
// clearly better-matching rival still outranks them), and in any bundled row a
// preferred-provider member becomes the `primary` (row title/thumb + title-click
// pick). With no preferred provider the output is identical to before.
function groupLookupHits(hits, max, preferredProvider) {
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
  let pinned = null; // { key, hit }: the preferred provider's overall-best hit
  groups.forEach((byProvider, key) => {
    const members = Array.from(byProvider.values()).sort(byPrio);
    const best = members.slice().sort(byRelevance)[0];
    // When a preferred provider is present in this group, it drives the row's
    // title/thumb + title-click pick; otherwise the highest-priority member.
    const preferredMember = preferredProvider && members.find((m) => m.provider === preferredProvider);
    const primary = preferredMember || members[0];
    const withThumb = members.find((m) => m.thumbnail);
    // Track the preferred provider's strongest hit across all groups; its group
    // gets pinned to the top regardless of how rivals score.
    if (preferredMember && (!pinned || byRelevance(preferredMember, pinned.hit) < 0)) {
      pinned = { key, hit: preferredMember };
    }
    result.push({
      key,
      title: primary.title,
      thumbnail: withThumb ? withThumb.thumbnail : null,
      primary,
      members,
      best,
      hasPreferred: !!preferredMember,
    });
  });

  const pinnedKey = pinned && pinned.key;
  result.sort((a, b) => {
    // The group holding the preferred provider's overall-best hit is pinned #1.
    const aPin = a.key === pinnedKey;
    const bPin = b.key === pinnedKey;
    if (aPin !== bPin) return aPin ? -1 : 1;
    // Otherwise relevance, with a preferred-provider member breaking score ties
    // (a distinctly better-matching rival still wins on score). Reduces exactly
    // to byRelevance(a.best, b.best) when no preferred provider is set.
    return b.best.score - a.best.score
      || (b.hasPreferred ? 1 : 0) - (a.hasPreferred ? 1 : 0)
      || a.best.prio - b.best.prio
      || a.best.order - b.best.order;
  });
  return typeof max === 'number' ? result.slice(0, max) : result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { groupLookupHits };
}
