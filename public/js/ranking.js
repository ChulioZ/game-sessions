/* Spieleabend – ranking: tie-aware podium places. Pure and dependency-free, so
   it works both as a shared-scope frontend script (browser global) and as a
   CommonJS module the test suite can require. Load order: see index.html. */

'use strict';

// Standard competition ranking ("1, 2, 2, 4") over rows already sorted
// descending by average. Two rows tie iff their averages match at the
// *displayed* one-decimal precision, so what the user sees as an equal `Ø X.X`
// is treated as equal. Unrated rows (count === 0, shown as "–") get no place
// (null): they never take a podium slot or a medal. Returns an array of places
// aligned to `rows`.
function computePlaces(rows) {
  let prevKey = null;
  let prevPlace = 0;
  return rows.map((r, i) => {
    if (!r.count) return null;
    const key = r.avg.toFixed(1);
    if (key === prevKey) return prevPlace;
    prevKey = key;
    prevPlace = i + 1;
    return prevPlace;
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePlaces };
}
