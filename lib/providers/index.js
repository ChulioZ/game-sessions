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

module.exports = { providers, getProvider, isAllowedImageUrl };
