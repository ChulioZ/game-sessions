'use strict';

/*
 * Add-game lookup: proxies external game-database providers (PlayStation Store,
 * BoardGameGeek, Steam, Nintendo eShop, Xbox) so the browser never makes the
 * cross-origin call itself.
 *
 * Mounted under /api/rounds/:rid/lookup (mergeParams for rid) — round-scoped
 * since #294, because which providers may be queried is a per-round setting and
 * has to be enforced server-side, not merely hidden in the UI:
 *
 *   GET /api/rounds/:rid/lookup/search?provider=psstore&q=witcher
 *       -> { results: [{ providerId, title, thumbnail }] }
 *   GET /api/rounds/:rid/lookup/game?provider=psstore&id=UP4497-PPSA10407_00-0
 *       -> { provider, externalId, title, minPlayers, maxPlayers, type,
 *            duration, imageUrl, url }
 *
 * Upstream failures return 502 { error: 'provider_unreachable' } so the UI can
 * show a "couldn't reach provider" state; an empty match set is a normal 200.
 */

const express = require('express');
const { getProvider } = require('../lib/providers');

const router = express.Router({ mergeParams: true });

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

// Resolve the requested provider against BOTH the registry and the round's
// enabled list (#294). Answers with the provider, or an { status, error } the
// caller returns as-is:
//   - unknown id            -> 400, as before
//   - round gone            -> 404
//   - registered but off    -> 403 provider_disabled
// A disabled provider must be REFUSED, not silently answered: the UI filters its
// fan-out too, so a request naming one is either a stale client or a hand-rolled
// call, and answering it would make the setting advisory rather than enforced.
async function resolveProvider(req) {
  const provider = getProvider(req.query.provider);
  if (!provider) return { status: 400, error: 'Unknown provider' };
  const round = await req.repo.getRound(req.params.rid);
  if (!round) return { status: 404, error: 'Round not found' };
  // Absent = never configured = every provider enabled (pre-#294 behaviour).
  const enabled = round.providers;
  if (Array.isArray(enabled) && !enabled.includes(provider.id)) {
    return { status: 403, error: 'provider_disabled' };
  }
  return { provider };
}

router.get('/search', async (req, res) => {
  const { provider, status, error } = await resolveProvider(req);
  if (!provider) return res.status(status).json({ error });
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
  const { provider, status, error } = await resolveProvider(req);
  if (!provider) return res.status(status).json({ error });
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
