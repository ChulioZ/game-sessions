'use strict';

/*
 * Add-game lookup: proxies external game-database providers (PlayStation Store,
 * BoardGameGeek, Steam, Nintendo eShop, Xbox) so the browser never makes the
 * cross-origin call itself. Mounted at /api/lookup in lib/app.js.
 *
 *   GET /api/lookup/search?provider=psstore&q=witcher
 *       -> { results: [{ providerId, title, thumbnail }] }
 *   GET /api/lookup/game?provider=psstore&id=UP4497-PPSA10407_00-0000000000000
 *       -> { provider, externalId, title, minPlayers, maxPlayers, type,
 *            duration, imageUrl, url }
 *
 * Upstream failures return 502 { error: 'provider_unreachable' } so the UI can
 * show a "couldn't reach provider" state; an empty match set is a normal 200.
 */

const express = require('express');
const { getProvider } = require('../lib/providers');

const router = express.Router();

// Tiny in-memory cache to be polite to the provider (debounced typing still
// repeats the same queries). Keyed per provider+kind+key, short TTL.
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  return Promise.resolve(fn()).then((value) => {
    cache.set(key, { value, expires: Date.now() + TTL_MS });
    return value;
  });
}

// The UI language the lookup should prefer for titles (currently only the BGG
// provider honors it; the digital stores use their env-configured locale). Kept
// to a tiny allowlist; defaults to 'en' for back-compat when the param is absent.
const LOOKUP_LANGS = ['de', 'en'];
function lookupLang(req) {
  const lang = String(req.query.lang || '').toLowerCase();
  return LOOKUP_LANGS.includes(lang) ? lang : 'en';
}

router.get('/search', async (req, res) => {
  const provider = getProvider(req.query.provider);
  if (!provider) return res.status(400).json({ error: 'Unknown provider' });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const lang = lookupLang(req);
  try {
    const results = await cached(`${provider.id}:search:${lang}:${q.toLowerCase()}`, () =>
      provider.search(q, undefined, lang)
    );
    res.json({ results });
  } catch {
    res.status(502).json({ error: 'provider_unreachable' });
  }
});

router.get('/game', async (req, res) => {
  const provider = getProvider(req.query.provider);
  if (!provider) return res.status(400).json({ error: 'Unknown provider' });
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const lang = lookupLang(req);
  try {
    const game = await cached(`${provider.id}:game:${lang}:${id}`, () => provider.detail(id, lang));
    if (!game) return res.status(404).json({ error: 'Not found' });
    res.json(game);
  } catch {
    res.status(502).json({ error: 'provider_unreachable' });
  }
});

module.exports = router;
