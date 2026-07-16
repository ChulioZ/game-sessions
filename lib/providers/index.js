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

// True if url is a cover image any registered provider vouches for. Used by the
// games route to gate the server-side download (a small SSRF guard).
const isAllowedImageUrl = (url) =>
  Object.values(providers).some((p) => p.imageHostAllowed(url));

// CSP img-src sources for provider covers, so the browser may RENDER the same
// hosts the server is allowed to DOWNLOAD from (isAllowedImageUrl) — one source
// of truth for "hosts we trust for covers" (lib/app.js consumes this). Each
// provider's download guard accepts a host h and any subdomain (host === h ||
// host.endsWith('.' + h)); CSP mirrors that with both the bare host and a `*.h`
// wildcard (a lone `*.h` does not match the apex).
const imageCspSources = () => {
  const hosts = new Set(Object.values(providers).flatMap((p) => p.imageHosts));
  return [...hosts].flatMap((h) => [h, '*.' + h]);
};

module.exports = { providers, getProvider, isAllowedImageUrl, imageCspSources };
