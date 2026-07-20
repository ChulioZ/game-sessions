/* Spielwirbel – game cover placeholders (#256). Pure and dependency-free, so it
   works both as a shared-scope frontend script (browser global) and as a
   CommonJS module the test suite can require. Load order: see index.html. */

'use strict';

// Neutral game icon shown on a card/thumbnail that has no cover image. Since
// games no longer carry a platform/type (#242), one generic glyph stands in for
// every game (`ti-dice-3` is declared in the bundled tabler-icons subset).
const GAME_ICON = 'ti-dice-3';

// Deterministic hue offset (0–359) for a game's cover placeholder, derived from
// its title so the same game always draws the same colour and two games in one
// round look distinct (#256) — not random per render, which would re-roll the
// colour on every re-render.
//
// FNV-1a, then a murmur3 finalizer. Two details are load-bearing, both found by
// the spread test in test/cover.test.js:
//   - `Math.imul`, not `*`. The FNV prime is ~2^24 and the accumulator ~2^32, so
//     a plain multiply lands past 2^53 and silently loses low bits to float
//     rounding — the exact bits `% 360` then reads. With `*` the distribution
//     collapsed badly (300 titles → 157 hues, worse than chance) and short
//     titles collided outright ("Catan" and "Azul" both hashed to 0.)
//   - The finalizer. FNV-1a's low bits are its weakest, and `% 360` reads
//     precisely those; avalanching them into the high bits first fixes it.
function gameHue(title) {
  const s = String(title == null ? '' : title);
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash = Math.imul(hash ^ s.charCodeAt(i), 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909);
  hash ^= hash >>> 16;
  return (hash >>> 0) % 360; // >>> 0 first: JS bitwise ops are signed
}

// Placeholder markup for a game cover frame that has no image (#256): an
// absolutely-positioned layer carrying a deterministic gradient (see the
// .cover-ph rules in styles.css, which derive both stops from --brand so every
// round theme stays coherent) plus the neutral game glyph.
//
// Returns '' when the game HAS a cover, so every call site is a plain
// `${coverPlaceholder(game)}` inside the frame — replacing the
// `game.image ? '' : '<i class="ti …">'` ternary that used to be copy-pasted at
// a dozen sites. Keeping it a child layer (rather than a background on the
// frame itself) matters: the big frames paint blurred/contained copies of their
// own `background-image` via ::before/::after (styles.css), which would
// otherwise inherit the gradient and draw it a second time, blurred.
function coverPlaceholder(game) {
  if (game && game.image) return '';
  const hue = gameHue(game && game.title);
  // Unitless on purpose: --cover-h is added to the `h` channel inside
  // oklch(from …), which is a <number> of degrees there. `calc(h + 40deg)` is a
  // type error the browser drops silently — the gradient then computes to
  // `none` and every card falls back to a flat box with no error anywhere.
  return `<span class="cover-ph" style="--cover-h:${hue}" aria-hidden="true"><i class="ti ${GAME_ICON}"></i></span>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GAME_ICON, gameHue, coverPlaceholder };
}
