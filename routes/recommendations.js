'use strict';

/*
 * Buy-next recommendations for a round — the opt-in LLM layer (issue #101,
 * "Layer B"). Mounted under /api/rounds/:rid/recommendations (mergeParams for
 * rid). The local, always-on "Layer A" lives client-side (public/js/buynext.js);
 * this router only powers the on-demand "Vorschläge generieren" button.
 *
 *   GET  -> the cached round.recommendations, or null if none generated yet.
 *   POST -> build an aggregated, member-anonymous taste profile, call the Claude
 *           Messages API via plain fetch (ANTHROPIC_API_KEY), cache the parsed
 *           list in the optional round.recommendations field, and return it.
 *
 * This is the app's first outbound LLM call — user-authorised (see
 * docs/recommendations-analysis.md) and strictly opt-in. It degrades so it can
 * never break the app: no key -> 503 { error: 'not_configured' }; upstream
 * failure/timeout/unparseable reply -> 502 { error: 'provider_unreachable' }.
 * Either way the client falls back to Layer A.
 *
 * Runs are kept as a history (issue #115): each generate appends a run rather
 * than overwriting the last, and nothing is auto-pruned, so the group can page
 * back through past proposals. The history lives in round.recommendationRuns
 * (newest first). The pre-#115 single round.recommendations object is read as a
 * one-run history and folded into the array the first time we write (ensureRuns),
 * so there is no standalone migration (see CLAUDE.md).
 */

const express = require('express');
const { saveData, findRound, id } = require('../lib/store');

const router = express.Router({ mergeParams: true });

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5'; // small/cheap model — capped output, one call
const MAX_TOKENS = 1024;
const MAX_ITEMS = 8;
const TIMEOUT_MS = 20000;

// The four concrete digital stores (mirror routes/games.js). `analog`, `other`,
// and legacy games without the field fall back to their analog/digital type.
const DIGITAL_PLATFORMS = ['ps', 'xbox', 'switch', 'steam'];
// locale (de/en) -> the language name the model should write reasons in.
const LANGUAGES = { de: 'German', en: 'English' };

// The recommendable platform for a game: its stored platform when it's one of
// the four concrete stores or analog, else inferred from the type. A digital
// game with no concrete store (`other`/digital, or a legacy field) can't be
// targeted at a store, so it returns null and is ignored for platform-awareness.
function gamePlatform(game) {
  if (game.platform === 'analog' || DIGITAL_PLATFORMS.includes(game.platform)) return game.platform;
  return game.type === 'analog' ? 'analog' : null;
}

// A deterministic store-*search* URL for a title on a platform — always
// resolvable (no scraping, no hallucinated product page). Locale follows the
// same env vars the lookup providers use (lib/providers/*). Returns null for a
// platform with no dedicated store (`other`).
function platformSearchUrl(platform, title) {
  const q = encodeURIComponent(title);
  switch (platform) {
    case 'analog':
      return `https://boardgamegeek.com/geeksearch.php?action=search&objecttype=boardgame&q=${q}`;
    case 'ps':
      return `https://store.playstation.com/${process.env.PSSTORE_LOCALE || 'de-de'}/search/${q}`;
    case 'steam':
      return `https://store.steampowered.com/search/?term=${q}`;
    case 'xbox':
      return `https://www.microsoft.com/${process.env.XBOX_LOCALE || 'de-de'}/search/shop/games?q=${q}`;
    case 'switch':
      return `https://www.nintendo.com/search/?q=${q}`;
    default:
      return null;
  }
}

// Per-game rating/play stats from a round's sessions — the server-side twin of
// gameStats() in public/js/core.js. Votes are the single source of truth, so
// this is derived on demand and nothing is denormalized.
function gameStats(round, gameId) {
  const ratings = [];
  let sessions = 0;
  (round.sessions || []).forEach((s) => {
    if (!Array.isArray(s.gameIds) || !s.gameIds.includes(gameId)) return;
    sessions++;
    (round.members || []).forEach((m) => {
      const v = ((s.votes || {})[m.id] || {})[gameId];
      if (v && typeof v.rating === 'number') ratings.push(v.rating);
    });
  });
  const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  return { avg, sessions };
}

// Most frequent value in a list (nulls/undefined ignored), or null if empty.
function mostCommon(values) {
  const counts = {};
  values.forEach((v) => {
    if (v === null || v === undefined || v === '') return;
    counts[v] = (counts[v] || 0) + 1;
  });
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
}

// A compact, aggregated, member-anonymous taste profile for the round: only
// titles + collection shape, never a member name or id. Exported so a test can
// assert no member identifier can leak into the outbound payload.
function buildProfile(round) {
  const active = (round.games || []).filter((g) => !g.retired);
  const rated = active
    .map((g) => ({ title: g.title, avg: gameStats(round, g.id).avg }))
    .filter((g) => g.avg !== null)
    .sort((a, b) => b.avg - a.avg);
  const topRated = rated.slice(0, 5).map((g) => g.title);
  const lowRated = rated
    .slice(-3)
    .map((g) => g.title)
    .filter((t) => !topRated.includes(t));
  const playerRanges = active
    .filter((g) => Number.isInteger(g.minPlayers) && Number.isInteger(g.maxPlayers))
    .map((g) => `${g.minPlayers}-${g.maxPlayers}`);
  // The concrete platforms the group actually plays on, so suggestions respect
  // the real mix. If no game carries a concrete digital platform (all analog, or
  // the field is absent), recommend board games only (analog).
  const present = [];
  active.forEach((g) => {
    const p = gamePlatform(g);
    if (p && !present.includes(p)) present.push(p);
  });
  const platforms = present.some((p) => DIGITAL_PLATFORMS.includes(p)) ? present : ['analog'];
  return {
    owned: active.map((g) => g.title),
    topRated,
    lowRated,
    favoriteType: mostCommon(active.map((g) => g.type)),
    favoriteDuration: mostCommon(active.map((g) => g.duration)),
    typicalPlayers: mostCommon(playerRanges),
    platforms,
  };
}

function buildPrompt(profile, locale) {
  const language = LANGUAGES[locale] || LANGUAGES.en;
  const platforms = profile.platforms || ['analog'];
  const analogOnly = platforms.length === 1 && platforms[0] === 'analog';
  return [
    "You recommend board games and digital games a gaming group should buy or play next.",
    "Here is an anonymized profile of the group's collection and taste:",
    JSON.stringify(profile, null, 2),
    '',
    `Suggest up to ${MAX_ITEMS} real, well-known games this group is likely to enjoy and does`,
    'NOT already own — exclude every title listed in "owned". Prefer titles matching their',
    'favorite type, duration and player counts. Favour widely-known real titles over obscure ones.',
    '',
    `Only recommend games available on these platforms: ${platforms.join(', ')}.`,
    'Tag every suggestion with exactly one of those platform ids in a "platform" field, and',
    'never recommend the same title on more than one platform.',
    analogOnly ? 'Every platform here is board games (analog), so suggest board games.' : '',
    '',
    `Write each "reason" in ${language}. Keep every game title in its real, original form`,
    '(do NOT translate the titles).',
    'Return ONLY a JSON array (no prose, no markdown fence) of objects with exactly this shape:',
    '[{ "title": "Game name", "platform": "one of the platform ids above", "reason": "one short sentence why they might like it" }].',
  ].filter(Boolean).join('\n');
}

// Pull the JSON array out of the model's text reply and sanitize it. Degrades
// to [] on any shape mismatch — never throws. Exported for unit testing.
function parseItems(data, owned, platforms) {
  const text = (data && Array.isArray(data.content) ? data.content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const ownedLower = new Set((owned || []).map((t) => String(t).toLowerCase()));
  const allowed = new Set(platforms && platforms.length ? platforms : ['analog']);
  // With a single target platform, a missing/odd platform on an item is safe to
  // bucket to it; with several, an item we can't place is dropped instead.
  const fallback = allowed.size === 1 ? [...allowed][0] : null;
  const seen = new Set();
  const items = [];
  for (const it of arr) {
    if (!it || typeof it.title !== 'string') continue;
    const title = it.title.trim();
    const key = title.toLowerCase();
    if (!title || ownedLower.has(key) || seen.has(key)) continue;
    let platform = typeof it.platform === 'string' ? it.platform.trim().toLowerCase() : '';
    if (!allowed.has(platform)) platform = fallback;
    if (!platform) continue; // several targets and the model gave one we can't place
    seen.add(key); // dedupe by title -> the same title never appears on two platforms
    items.push({
      title,
      platform,
      reason: typeof it.reason === 'string' ? it.reason.trim() : '',
      url: platformSearchUrl(platform, title),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

// Call the Claude Messages API for a buy-next list. Returns { items, model } on
// success or { error } ('not_configured' | 'provider_unreachable'); never throws.
async function generate(profile, locale) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: 'not_configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: buildPrompt(profile, locale) }],
      }),
    });
    if (!res.ok) return { error: 'provider_unreachable' };
    const data = await res.json();
    const items = parseItems(data, profile.owned, profile.platforms);
    if (!items.length) return { error: 'provider_unreachable' };
    return { items, model: (data && typeof data.model === 'string' && data.model) || MODEL };
  } catch {
    return { error: 'provider_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// The round's run history as a plain array, newest first — read defensively so
// no migration is needed (CLAUDE.md). Prefers the #115 round.recommendationRuns
// array; otherwise folds the legacy single round.recommendations object into a
// one-run history (given a stable synthetic id, since it predates run ids).
// Pure: never mutates the round (GET must be side-effect-free).
function history(round) {
  if (Array.isArray(round.recommendationRuns)) return round.recommendationRuns;
  if (round.recommendations && Array.isArray(round.recommendations.items)) {
    return [{ id: 'legacy', ...round.recommendations }];
  }
  return [];
}

// Materialize round.recommendationRuns from history() before a write, so a
// mutation (append/delete) operates on the array and the legacy object is
// retired in the same save — the one place the read-time normalization is
// persisted. Callers must saveData() after mutating.
function ensureRuns(round) {
  if (!Array.isArray(round.recommendationRuns)) {
    round.recommendationRuns = history(round);
    delete round.recommendations;
  }
  return round.recommendationRuns;
}

router.get('/', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  res.json(history(round));
});

router.post('/', async (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  // Active UI locale, sent by the client; anything but 'de' falls back to 'en'.
  const locale = req.body && req.body.locale === 'de' ? 'de' : 'en';
  const result = await generate(buildProfile(round), locale);
  if (result.error === 'not_configured') return res.status(503).json({ error: 'not_configured' });
  if (result.error) return res.status(502).json({ error: 'provider_unreachable' });
  const run = {
    id: id(),
    generatedAt: new Date().toISOString(),
    model: result.model,
    locale,
    items: result.items,
  };
  // Append (newest first), keeping every past run — nothing is pruned (#115).
  ensureRuns(round).unshift(run);
  saveData();
  res.json(run);
});

router.delete('/:runId', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const runs = ensureRuns(round);
  const idx = runs.findIndex((r) => r.id === req.params.runId);
  if (idx === -1) return res.status(404).json({ error: 'Run not found' });
  runs.splice(idx, 1);
  saveData();
  res.json(runs);
});

// The router is the module's default export (so lib/app.js can mount it); the
// pure helpers hang off it for the unit tests.
router.buildProfile = buildProfile;
router.buildPrompt = buildPrompt;
router.parseItems = parseItems;
router.platformSearchUrl = platformSearchUrl;
router.history = history;
module.exports = router;
