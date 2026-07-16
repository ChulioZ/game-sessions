'use strict';

/*
 * Nintendo eShop provider (digital Nintendo Switch games) for the add-game
 * lookup.
 *
 * Nintendo has no official public API, but Nintendo of Europe powers its store
 * search with a public, key-free Solr endpoint at searching.nintendo-europe.com.
 * A single query returns everything we need — id, title, player counts, cover
 * image and the store path — so, unlike the other digital stores, both hops hit
 * the same endpoint:
 *
 *   - search: searching.nintendo-europe.com/{locale}/select?q=<name>&
 *     fq=type:GAME&fq=system_type:nintendoswitch — the Switch filter keeps the
 *     result set to current eShop titles instead of retro / Virtual Console
 *     re-releases of the same name. Returns { response: { docs: [...] } }.
 *   - detail: the same endpoint filtered to one item (fq=fs_id:<id>), so a
 *     picked result yields the real title, cover, players and store link.
 *
 * This is an undocumented storefront endpoint, so every parser degrades to
 * null/empty rather than throwing. Nintendo exposes no play-time, so `duration`
 * defaults to the long bucket (consistent with the other digital stores). The
 * pure parsers are exported for unit tests (no network needed).
 */

// Nintendo of Europe's key-free Solr search endpoint.
const SEARCH_BASE = 'https://searching.nintendo-europe.com';
// The store front that serves the product pages the search `url` points at.
const STORE = 'https://www.nintendo.com';
// The Solr index/store is localized; default to the German store, overridable.
// Values are NoE language codes like 'de', 'en', 'fr'.
const LOCALE = process.env.NINTENDO_LOCALE || 'de';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 10000;

// Cover images live on Nintendo's own CDN (www.nintendo.com/eu/media/...); the
// games route only downloads images whose host is on a provider's allowlist (a
// small SSRF guard).
const IMAGE_HOSTS = ['nintendo.com'];

// Coerce a Solr player-count field (numbers, "0"/missing = unknown) to a
// positive integer, or null.
function toPositiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Escape a value for embedding inside a Solr double-quoted phrase, so a crafted
// id can't inject query syntax (worst case it just returns no docs).
function escapeSolrPhrase(s) {
  return String(s).replace(/[\\"]/g, '\\$&');
}

// Choose the best cover image URL from a Solr doc, or null. Prefers the square
// cover, falling back to the primary and the wide (2x1) share image.
function pickImage(doc) {
  if (!doc || typeof doc !== 'object') return null;
  for (const url of [doc.image_url_sq_s, doc.image_url, doc.image_url_h2x1_s]) {
    if (typeof url === 'string' && url) return url;
  }
  return null;
}

// Pull the docs array out of a Solr response, or [].
function docsOf(json) {
  return json && json.response && Array.isArray(json.response.docs) ? json.response.docs : [];
}

// Parse a Solr search response into [{ providerId, title, thumbnail }].
// providerId is the fs_id; the cover thumbnail is available right here (no
// second fetch needed). Deduped by fs_id; entries without an id or title are
// skipped. Never throws.
function parseSearch(json, limit = 8) {
  const out = [];
  const seen = new Set();
  for (const doc of docsOf(json)) {
    const id = doc && doc.fs_id != null ? String(doc.fs_id) : '';
    const title = doc && doc.title ? String(doc.title) : '';
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    out.push({ providerId: id, title, thumbnail: pickImage(doc) });
    if (out.length >= limit) break;
  }
  return out;
}

// Parse a single-item Solr response into a normalized detail object. Never null
// (mirrors the other providers): a missing item yields the same shape with null
// fields, so the "View on Nintendo eShop" link still works.
function parseDetail(json, externalId) {
  const doc = docsOf(json)[0] || null;
  const path = doc && typeof doc.url === 'string' && doc.url ? doc.url : null;
  return {
    provider: 'nintendo',
    externalId: String(externalId),
    title: doc && doc.title ? String(doc.title) : null,
    minPlayers: doc ? toPositiveInt(doc.players_from) : null,
    maxPlayers: doc ? toPositiveInt(doc.players_to) : null,
    type: 'digital',
    // Nintendo exposes no play-time; default digital titles to the long bucket,
    // which is almost always the right one (matches the other digital stores).
    duration: 'long',
    imageUrl: pickImage(doc),
    url: path ? `${STORE}${path}` : STORE,
  };
}

// True if url points at a Nintendo image host (used to gate the cover download).
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

// Fetch a URL as parsed JSON with a browser-like UA and a timeout. Throws on
// non-2xx or invalid JSON.
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Nintendo responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function search(query, limit = 8) {
  const params = new URLSearchParams({ q: query, wt: 'json', rows: String(limit) });
  // Solr allows repeated fq params (AND-ed): only games, only Switch-family
  // titles (drops retro / Virtual Console re-releases of the same name).
  params.append('fq', 'type:GAME');
  params.append('fq', 'system_type:nintendoswitch');
  return parseSearch(await fetchJson(`${SEARCH_BASE}/${LOCALE}/select?${params.toString()}`), limit);
}

async function detail(externalId) {
  const params = new URLSearchParams({ q: '*:*', wt: 'json', rows: '1' });
  params.append('fq', 'type:GAME');
  params.append('fq', `fs_id:"${escapeSolrPhrase(externalId)}"`);
  return parseDetail(await fetchJson(`${SEARCH_BASE}/${LOCALE}/select?${params.toString()}`), externalId);
}

module.exports = {
  id: 'nintendo',
  label: 'Nintendo eShop',
  search,
  detail,
  imageHostAllowed,
  imageHosts: IMAGE_HOSTS, // trusted cover hosts (feeds the CSP img-src allowlist)
  // exported for unit tests:
  parseSearch,
  parseDetail,
  pickImage,
};
