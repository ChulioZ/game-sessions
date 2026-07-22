/* Spielwirbel – lookup relevance: how well a provider hit's title answers the
   typed query. Pure and dependency-free, so it works both as a shared-scope
   frontend script (browser global) and as a CommonJS module the test suite can
   require. Load order: see index.html (before views-round-lookup.js). */

'use strict';

// Fold a string to a comparable form before any tier check: ß→ss, diacritics
// stripped, and every run of non-letter/non-digit characters collapsed to a
// single space. Mirrors norm() in lib/providers/bgg.js, which already does
// this for BGG's ranking *within* its own results.
//
// The collapse is what fixes #317: the tiers below tokenize on whitespace, so
// a query like "… Quedlinburg - Megabox" used to yield a dead "-" token that
// can never prefix a real word. That one token made the loose tier's every()
// fail, scoring an obviously-correct hit 0 — indistinguishable from a
// completely unrelated title, at which point groupLookupHits' tiebreak handed
// the row order to provider priority alone.
//
// Letters are matched by Unicode property, not [a-z]: stripping whole scripts
// would fold e.g. "Catan Двубоят" down to a bare "catan".
function foldTitle(s) {
  return String(s || '')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Query-match relevance tier (higher = better), on folded strings. Exact-match
// tiers only — no fuzzy/edit-distance matching, deliberately (see
// .claude/rules/add-game-lookup-provider.md).
function scoreHit(title, q) {
  const s = foldTitle(title);
  const query = foldTitle(q);
  if (!s || !query) return 0;
  if (s === query) return 5; // exact title
  if (s.startsWith(query)) return 4; // title starts with the query
  const words = s.split(' ');
  if (words.some((w) => w.startsWith(query))) return 3; // query at a word boundary
  if (s.includes(query)) return 2; // query anywhere as a substring
  const qTokens = query.split(' ').filter(Boolean);
  if (qTokens.length && qTokens.every((qt) => words.some((w) => w.startsWith(qt))))
    return 1; // loose: every query token is a word-prefix in the title
  return 0; // no match
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scoreHit, foldTitle };
}
