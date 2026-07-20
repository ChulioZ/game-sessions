/* Spielwirbel – render-time cover URL sizing (#298). Pure and dependency-free,
   so it works both as a shared-scope frontend script (browser global) and as a
   CommonJS module the test suite can require. Load order: see index.html. */

'use strict';

// Frame-appropriate widths, in CSS px * ~1.5 for DPR headroom. Pass one of
// these to coverUrl() at each render site so the browser downloads a cover
// sized for the box it lands in, not the provider's print-resolution master.
//   THUMB — 38–74px chips: pool thumbs, result rows, tickets, archive rows
//   CARD  — the Regal grid (minmax(220px, 1fr) at aspect-ratio 4/3)
//   HERO  — the game-detail hero (240px) and the voting screen's big frame
const COVER_THUMB = 160;
const COVER_CARD = 330;
const COVER_HERO = 480;

// Cover hosts whose CDN takes a resize query, and the query each one wants.
// Verified against live URLs on 2026-07-20: a PS Store master shrank 326 KB →
// 8 KB at ?w=330, an Xbox master 681 KB → 42 KB at ?w=330&h=330&q=90.
//
// Only Sony and Microsoft are listed, and that is the whole point: BGG already
// hands us a `fit-in/246x300` CDN URL (~20 KB) and Steam a `capsule_*` crop
// (~50 KB), so both are already right-sized, and Nintendo's CDN ignores `?w=`
// entirely (byte-identical response) so appending one would be noise. Adding a
// host here means checking that its CDN actually honours the parameter —
// an unrecognised host passing through untouched is the safe default.
//
// Each entry matches the host itself and any subdomain, mirroring the
// `host === h || host.endsWith('.' + h)` shape every provider's download guard
// uses (lib/providers/*.js IMAGE_HOSTS).
const COVER_RESIZERS = [
  { host: 'image.api.playstation.com', query: (w) => `w=${w}` },
  { host: 'playstation.net', query: (w) => `w=${w}` },
  { host: 's-microsoft.com', query: (w) => `w=${w}&h=${w}&q=90` },
];

// Rewrite a stored cover URL to a size-appropriate variant for a frame `width`
// CSS px wide. Returns `image` untouched unless it is an https:// URL on a host
// we know how to resize — so own uploads (`/uploads/<key>`), every unrecognised
// host, and anything that isn't a string pass through byte-identically.
//
// This is deliberately a RENDER-time rewrite rather than a change to what
// `pickImage()` stores: it fixes the entire existing corpus of already-linked
// games for free on their next load, and keeps the stored value the provider's
// own canonical URL. There is no migration code in this repo by design
// (CLAUDE.md), so a capture-time-only fix would leave every saved game slow.
//
// A URL that already carries a query string is left alone. That guard is what
// lets a capture-time change land later without conflicting — and it already
// matters today: the Xbox *search* hit's thumbnail arrives pre-sized as
// `?w=150&h=150`, so appending a second `w=` would produce a malformed query.
function coverUrl(image, width) {
  if (typeof image !== 'string' || !image.startsWith('https://')) return image;
  if (image.includes('?')) return image;
  let host;
  try {
    host = new URL(image).hostname.toLowerCase();
  } catch {
    return image; // not parseable — nothing safe to rewrite
  }
  const match = COVER_RESIZERS.find(
    (r) => host === r.host || host.endsWith('.' + r.host)
  );
  if (!match) return image;
  return `${image}?${match.query(width)}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COVER_THUMB, COVER_CARD, COVER_HERO, COVER_RESIZERS, coverUrl };
}
