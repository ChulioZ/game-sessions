/* Spielwirbel – lookup covers: which image a picked provider match yields.
   Pure and dependency-free, so it works both as a shared-scope frontend script
   (browser global) and as a CommonJS module the test suite can require. Load
   order: see index.html (before views-round-lookup.js). */

'use strict';

// The cover to offer for a picked match, given the search hit `r` and the
// detail response `d`.
//
// A provider's *detail* response may carry no image, and PS Store is the one
// that doesn't: parseProduct calls pickImage(product.media), so it reads like
// it should work, but a *product* page's __NEXT_DATA__ holds only a bare
// Product stub with no `media` array — the cover exists solely on the *search*
// page's Apollo entries. BGG, Steam, Nintendo and Xbox all populate imageUrl
// from detail, which is why only Sony was affected (issue #281).
//
// So: detail wins whenever it has one (the other four are untouched), else fall
// back to the search thumbnail — exactly what the add-game flow already does
// inline. Both sources come from the same pickImage() helper and therefore the
// same provider IMAGE_HOSTS, so the server's providerCoverUrl() allowlist
// accepts either and no server change is needed.
//
// Returns null when neither side has one, so callers can gate the cover field
// on a falsy result.
function providerMatchCover(r, d) {
  return (d && d.imageUrl) || (r && r.thumbnail) || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { providerMatchCover };
}
