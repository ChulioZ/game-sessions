'use strict';

/*
 * Provider registry for the add-game lookup. One module per external game
 * database; each exposes search(query)/detail(externalId)/imageHostAllowed(url).
 * A second provider (e.g. an analog-games source) is just another entry here.
 */

const psstore = require('./psstore');
const bgg = require('./bgg');
const steam = require('./steam');
const nintendo = require('./nintendo');
const xbox = require('./xbox');

const providers = {
  [psstore.id]: psstore,
  [bgg.id]: bgg,
  [steam.id]: steam,
  [nintendo.id]: nintendo,
  [xbox.id]: xbox,
};

const getProvider = (name) => providers[name] || null;

// True if url is a cover image any registered provider vouches for.
const isAllowedImageUrl = (url) =>
  Object.values(providers).some((p) => p.imageHostAllowed(url));

// Characters that must never reach a stored cover URL, because the frontend
// interpolates game.image straight into `background-image:url('<image>')` —
// sometimes inside a `style="…"` attribute, sometimes via el.style (core.js
// loadCover). Every render site uses the QUOTED url('…') form, so what actually
// terminates the value is:
//   '   ends the CSS string
//   \   starts a CSS escape
//   "   ends the surrounding HTML style attribute
//   whitespace/control  ends the string / the attribute
//   <>  never needed in a cover URL; refused so a future HTML context is safe
//
// Parens are deliberately ALLOWED: they are legal inside a quoted CSS string,
// and real provider URLs contain them — BGG's CDN serves covers under paths like
// `filters:strip_icc()`, which an over-strict guard silently drops (the cover
// then just never appears, with nothing logged).
const COVER_UNSAFE_RE = /['"<>\\\s]/;

// The cover URL to STORE for a provider image, or null when we don't trust it.
//
// Provider cover art is HOTLINKED, not re-hosted (#172): game.image holds the
// provider's own https URL and the browser fetches it from them. Re-hosting it
// would be reproduction + making available (§§ 16, 19a UrhG) of third-party
// artwork we hold no licence for — see .claude/rules/provider-cover-hotlinking.md.
// https only: a stored http URL would be blocked as mixed content on the live
// (HTTPS) origin and silently render nothing.
const providerCoverUrl = (url) => {
  const u = String(url || '');
  if (!u || COVER_UNSAFE_RE.test(u) || !u.startsWith('https://')) return null;
  return isAllowedImageUrl(u) ? u : null;
};

// CSP img-src sources for provider covers, so the browser may RENDER the hosts
// we vouch for (isAllowedImageUrl) — one source of truth for "hosts we trust for
// covers" (lib/app.js consumes this). Since #172 this is what makes hotlinked
// covers display at all, not just the lookup previews. Each
// provider's download guard accepts a host h and any subdomain (host === h ||
// host.endsWith('.' + h)); CSP mirrors that with both the bare host and a `*.h`
// wildcard (a lone `*.h` does not match the apex).
const imageCspSources = () => {
  const hosts = new Set(Object.values(providers).flatMap((p) => p.imageHosts));
  return [...hosts].flatMap((h) => [h, '*.' + h]);
};

module.exports = {
  providers,
  getProvider,
  isAllowedImageUrl,
  providerCoverUrl,
  imageCspSources,
};
