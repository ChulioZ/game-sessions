'use strict';

/*
 * BoardGameGeek provider (analog games) for the add-game lookup.
 *
 * BGG's own search is not usable without a key: the XML API2 requires a
 * registered app + Bearer token (since 2025-07-02) and the website search
 * returns 403 to scripts. So this provider gets BGG's rich data with NO key by
 * splitting the job across two public endpoints:
 *
 *   - search: the Wikidata Query Service (SPARQL). We run Wikidata's full-text
 *     search (CirrusSearch via wikibase:mwapi), restricted to entities that
 *     carry a BoardGameGeek ID (property P2339). Wikidata is only the search
 *     *index*: it maps the typed name to a BGG object id + a human label.
 *     It's a documented, stable, key-free public endpoint.
 *   - detail: BGG's own public JSON endpoint (api.geekdo.com/api/geekitems) —
 *     the API behind the public site, no auth. It returns the real fields
 *     (title, min/max players, play time, cover image, canonical link), so the
 *     game we save — its data, its cover, and its "View on BoardGameGeek" link —
 *     is genuinely BoardGameGeek, not Wikidata.
 *
 * Both hops are undocumented / scraping-adjacent, so every parser degrades to
 * null/empty instead of throwing. The pure parsers are exported for unit tests.
 */

// Wikidata Query Service (SPARQL) — the search index.
const WDQS = 'https://query.wikidata.org/sparql';
// BGG's public JSON item endpoint — the detail source.
const GEEKITEMS = 'https://api.geekdo.com/api/geekitems';
const WEB = 'https://boardgamegeek.com';
// A descriptive User-Agent is required by the Wikimedia API etiquette and is
// polite to BGG too. No key, just identifies the app.
const USER_AGENT = 'game-sessions/1.0 (self-hosted board-game collection app)';
const TIMEOUT_MS = 10000;

// Cover images live on BGG's image CDN; the games route only downloads images
// whose host is on a provider's allowlist (a small SSRF guard).
const IMAGE_HOSTS = ['cf.geekdo-images.com', 'geekdo-images.com'];

// Escape a user string for embedding inside a SPARQL double-quoted literal, so a
// typed quote/backslash can't break the query (worst case it just returns []).
function escapeSparqlString(s) {
  return String(s).replace(/[\\"]/g, '\\$&').replace(/[\n\r\t]/g, ' ');
}

// The label-service language chain for a requested locale: preferred language
// first, then the other one as a fallback (so a missing localized name yields
// the other language rather than the bare Q-id). Guards against injection into
// the language literal — anything that isn't a 2-letter code falls back to en.
function labelLanguages(lang) {
  const l = /^[a-z]{2}$/.test(lang) ? lang : 'en';
  const other = l === 'de' ? 'en' : 'de';
  return `${l},${other}`;
}

// Build the SPARQL that searches Wikidata for `query` among items with a BGG id
// and returns each item's BGG id + label in the requested language (with the
// other language as fallback). Exported for unit tests.
function buildSparql(query, limit = 8, lang = 'en') {
  const q = escapeSparqlString(query);
  return `SELECT ?item ?itemLabel ?bgg WHERE {
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:api "Search" ;
                    wikibase:endpoint "www.wikidata.org" ;
                    mwapi:srsearch "${q} haswbstatement:P2339" ;
                    mwapi:limit "20" .
    ?item wikibase:apiOutputItem mwapi:title .
  }
  ?item wdt:P2339 ?bgg .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${labelLanguages(lang)}". }
} LIMIT ${limit}`;
}

// Build the SPARQL that fetches the label of the Wikidata entity carrying the
// given BGG id (property P2339), in the requested language chain. Used on pick
// so the saved title follows the UI language instead of BGG's English canonical
// name. Exported for unit tests.
function buildLabelSparql(externalId, lang = 'en') {
  const id = escapeSparqlString(externalId);
  return `SELECT ?itemLabel WHERE {
  ?item wdt:P2339 "${id}" .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${labelLanguages(lang)}". }
} LIMIT 1`;
}

// Coerce a BGG field (numbers arrive as strings like "4") to a positive integer,
// or null. BGG uses "0" for "unknown", which we treat as null.
function toPositiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Map a BGG play time (minutes) to the app's duration bucket, matching the
// add-game hint (short < 30 · medium 30–60 · long > 60). Uses the average of
// min/max play time as the representative value; null when BGG has no play time.
function bucketDuration(minPlay, maxPlay) {
  const lo = toPositiveInt(minPlay);
  const hi = toPositiveInt(maxPlay);
  const vals = [lo, hi].filter((n) => n !== null);
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (avg < 30) return 'short';
  if (avg <= 60) return 'medium';
  return 'long';
}

// Choose the best cover image URL for a BGG item, or null. Prefers the full
// representative image, falling back to the medium/thumb variants.
function pickImage(item) {
  if (!item || typeof item !== 'object') return null;
  const candidates = [item.imageurl, item.images && item.images.medium, item.images && item.images.thumb];
  for (const url of candidates) {
    if (typeof url === 'string' && url) return url;
  }
  return null;
}

// Parse a Wikidata SPARQL results object into [{ providerId, title, thumbnail }].
// providerId is the BGG object id; thumbnail is null (the cover comes from the
// BGG detail on pick). Deduped by BGG id; entries without a real label or a
// numeric BGG id are dropped. Never throws.
function parseSearch(json, limit = 8) {
  const rows = json && json.results && Array.isArray(json.results.bindings) ? json.results.bindings : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const bgg = row && row.bgg && row.bgg.value;
    const title = row && row.itemLabel && row.itemLabel.value;
    if (!bgg || !/^\d+$/.test(bgg) || seen.has(bgg)) continue;
    if (!title || /^Q\d+$/.test(title)) continue; // skip items with no real label
    seen.add(bgg);
    out.push({ providerId: bgg, title, thumbnail: null });
    if (out.length >= limit) break;
  }
  return out;
}

// Extract a localized label from a buildLabelSparql result, or null. Skips the
// bare Q-id placeholder Wikidata returns when there is no label in any requested
// language (so detail() then keeps BGG's own name). Never throws.
function parseLabel(json) {
  const rows = json && json.results && Array.isArray(json.results.bindings) ? json.results.bindings : [];
  const label = rows[0] && rows[0].itemLabel && rows[0].itemLabel.value;
  if (!label || /^Q\d+$/.test(label)) return null;
  return label;
}

// Parse a BGG geekitems JSON response into a normalized detail object. Never
// null (mirrors the PS Store provider): a missing/short item yields the same
// shape with null fields, so the "View on BoardGameGeek" link still works.
function parseProduct(json, externalId) {
  const item = json && json.item && typeof json.item === 'object' ? json.item : null;
  const canonical = item && typeof item.canonical_link === 'string' ? item.canonical_link : null;
  return {
    provider: 'bgg',
    externalId,
    title: item && item.name ? String(item.name) : null,
    minPlayers: item ? toPositiveInt(item.minplayers) : null,
    maxPlayers: item ? toPositiveInt(item.maxplayers) : null,
    type: 'analog',
    duration: item ? bucketDuration(item.minplaytime, item.maxplaytime) : null,
    imageUrl: pickImage(item),
    url: canonical || `${WEB}/boardgame/${externalId}`,
  };
}

// True if url points at a BGG image host (used to gate the cover download).
function imageHostAllowed(urlStr) {
  let host;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return IMAGE_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// Fetch a URL as parsed JSON with a descriptive UA and a timeout. Throws on
// non-2xx or invalid JSON.
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`BGG provider upstream responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function search(query, limit = 8, lang = 'en') {
  const params = new URLSearchParams({ query: buildSparql(query, limit, lang), format: 'json' });
  return parseSearch(await fetchJson(`${WDQS}?${params.toString()}`), limit);
}

// Resolve the Wikidata label for a BGG id in the requested language, or null.
// Best-effort: any failure (Wikidata down, no entity, no label) yields null so
// detail() falls back to BGG's own canonical (English) name — never throws.
async function localizedTitle(externalId, lang) {
  try {
    const params = new URLSearchParams({ query: buildLabelSparql(externalId, lang), format: 'json' });
    return parseLabel(await fetchJson(`${WDQS}?${params.toString()}`));
  } catch {
    return null;
  }
}

async function detail(externalId, lang = 'en') {
  const params = new URLSearchParams({ objectid: externalId, objecttype: 'thing', nosession: '1' });
  const product = parseProduct(await fetchJson(`${GEEKITEMS}?${params.toString()}`), externalId);
  const localized = await localizedTitle(externalId, lang);
  if (localized) product.title = localized;
  return product;
}

module.exports = {
  id: 'bgg',
  label: 'BoardGameGeek',
  search,
  detail,
  imageHostAllowed,
  // exported for unit tests:
  buildSparql,
  buildLabelSparql,
  parseSearch,
  parseLabel,
  parseProduct,
  bucketDuration,
  pickImage,
};
