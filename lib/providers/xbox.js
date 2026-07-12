'use strict';

/*
 * Xbox / Microsoft Store provider (digital Xbox & PC games) for the add-game
 * lookup.
 *
 * Microsoft has no simple key-free "search games" API, but two public,
 * key-free endpoints together give us everything, so this provider splits the
 * job across them (like the BoardGameGeek provider):
 *
 *   - search: www.microsoft.com/msstoreapiprod/api/autosuggest — the storefront
 *     autosuggest used by the site's search box. Returns
 *     { ResultSets: [{ Suggests: [{ Source, Title, ImageUrl, Metas }] }] };
 *     each game suggest carries a BigCatalogId (the store product id) in Metas.
 *     We keep Source === 'Game' (drops apps / DLC / non-game suggestions).
 *   - detail: displaycatalog.mp.microsoft.com/v7.0/products/<id> — the public
 *     catalog service behind the store (no auth). Returns the real title, the
 *     box-art cover, and the player counts (from Xbox Live capability
 *     Attributes like XblOnlineCoop / XblLocalMultiplayer).
 *
 * Both endpoints are undocumented/store-facing, so every parser degrades to
 * null/empty rather than throwing. The Microsoft Store exposes no play-time, so
 * `duration` defaults to the long bucket (consistent with the other digital
 * stores). The pure parsers are exported for unit tests (no network needed).
 */

// Storefront autosuggest (search) and the public catalog service (detail).
const AUTOSUGGEST = 'https://www.microsoft.com/msstoreapiprod/api/autosuggest';
const CATALOG = 'https://displaycatalog.mp.microsoft.com/v7.0/products';
// The store front that serves the product pages the source link points at.
const STORE = 'https://www.xbox.com';
// The store is localized; default to the German store (German UI) but allow an
// override. Format is a language-region tag like 'de-de' or 'en-us'.
const LOCALE = process.env.XBOX_LOCALE || 'de-de';
// displaycatalog wants a bare country market ('DE'); derive it from the locale.
const MARKET = (LOCALE.split('-')[1] || 'us').toUpperCase();
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 10000;

// Cover images live on Microsoft's store image CDN (store-images.s-microsoft.com);
// the games route only downloads images whose host is on a provider's allowlist
// (a small SSRF guard).
const IMAGE_HOSTS = ['s-microsoft.com'];

// Box art we prefer, best first. Falls back to any image with a URL.
const IMAGE_PURPOSES = ['BoxArt', 'Poster', 'TitledHeroArt', 'SuperHeroArt'];

// Xbox Live capability attributes that imply a player count. Names are stable
// across languages; each may carry a numeric Minimum/Maximum.
const MULTIPLAYER_ATTR = /(?:Multiplayer|Coop)$/;

// Microsoft's image URLs are protocol-relative ('//store-images...'); make them
// absolute https, or return null for anything empty/non-string.
function httpsUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  if (u.startsWith('//')) return `https:${u}`;
  return u;
}

// Read a suggest's Metas entry by key (BigCatalogId, ProductType, …), or null.
function metaValue(suggest, key) {
  const metas = suggest && Array.isArray(suggest.Metas) ? suggest.Metas : [];
  const hit = metas.find((m) => m && m.Key === key);
  return hit && hit.Value != null ? String(hit.Value) : null;
}

// Choose the best cover image URL from a catalog Images array, or null. Prefers
// the square box art, falling back through poster/hero art to any image.
function pickImage(images) {
  const list = Array.isArray(images) ? images : [];
  for (const purpose of IMAGE_PURPOSES) {
    const hit = list.find((im) => im && im.ImagePurpose === purpose && im.Uri);
    if (hit) return httpsUrl(hit.Uri);
  }
  const any = list.find((im) => im && im.Uri);
  return any ? httpsUrl(any.Uri) : null;
}

// Parse an autosuggest response into [{ providerId, title, thumbnail }]. Walks
// every ResultSet, keeps only game suggestions (Source 'Game') carrying a
// BigCatalogId. Deduped by id; entries without an id or title are skipped.
// Never throws.
function parseSearch(json, limit = 8) {
  const sets = json && Array.isArray(json.ResultSets) ? json.ResultSets : [];
  const out = [];
  const seen = new Set();
  for (const set of sets) {
    const suggests = set && Array.isArray(set.Suggests) ? set.Suggests : [];
    for (const s of suggests) {
      if (!s || s.Source !== 'Game') continue;
      const id = metaValue(s, 'BigCatalogId');
      const title = s.Title ? String(s.Title) : '';
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      out.push({ providerId: id, title, thumbnail: httpsUrl(s.ImageUrl) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Coerce an Attribute bound to a positive integer, or null.
function toPositiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Derive a best-effort { min, max } player count from a catalog Attributes
// array. Single-player support (a 'SinglePlayer' attribute) floors the minimum
// at 1; multiplayer/coop attributes contribute the numeric bounds, and the max
// is the widest any of them allows. Unknown stays null (never invented).
function parsePlayers(attributes) {
  const list = Array.isArray(attributes) ? attributes : [];
  const hasSingle = list.some((a) => a && a.Name === 'SinglePlayer');
  let max = null;
  let minMulti = null;
  for (const a of list) {
    if (!a || typeof a.Name !== 'string' || !MULTIPLAYER_ATTR.test(a.Name)) continue;
    const hi = toPositiveInt(a.Maximum);
    const lo = toPositiveInt(a.Minimum);
    if (hi != null && (max == null || hi > max)) max = hi;
    if (lo != null && (minMulti == null || lo < minMulti)) minMulti = lo;
  }
  let min = hasSingle ? 1 : minMulti;
  if (max == null) max = hasSingle ? 1 : null;
  // A max below the min is nonsense from partial data; drop the max.
  if (min != null && max != null && max < min) max = min;
  return { min: min == null ? null : min, max };
}

// Parse a catalog product response into a normalized detail object. Never null
// (mirrors the other providers): a missing product yields the same shape with
// null fields, so the "View on Xbox" link still works.
function parseDetail(json, externalId, locale = LOCALE) {
  const product = json && json.Product && typeof json.Product === 'object' ? json.Product : null;
  const localized =
    product && Array.isArray(product.LocalizedProperties) ? product.LocalizedProperties[0] : null;
  const attributes = product && product.Properties ? product.Properties.Attributes : null;
  const { min, max } = parsePlayers(attributes);
  return {
    provider: 'xbox',
    externalId: String(externalId),
    title: localized && localized.ProductTitle ? String(localized.ProductTitle) : null,
    minPlayers: min,
    maxPlayers: max,
    type: 'digital',
    // The Microsoft Store exposes no play-time; default digital titles to the
    // long bucket, which is almost always the right one (matches the other
    // digital stores). Pre-selects "long" in the add-game sheet.
    duration: 'long',
    imageUrl: localized ? pickImage(localized.Images) : null,
    url: `${STORE}/${locale}/games/store/_/${encodeURIComponent(externalId)}`,
  };
}

// True if url points at a Microsoft store-image host (used to gate the cover
// download).
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
    if (!res.ok) throw new Error(`Xbox responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function search(query, limit = 8) {
  const params = new URLSearchParams({
    market: LOCALE,
    sources: 'DCatAll-Products',
    query,
  });
  return parseSearch(await fetchJson(`${AUTOSUGGEST}?${params.toString()}`), limit);
}

async function detail(externalId) {
  const params = new URLSearchParams({
    market: MARKET,
    languages: LOCALE,
    fieldsTemplate: 'Details',
  });
  const url = `${CATALOG}/${encodeURIComponent(externalId)}?${params.toString()}`;
  return parseDetail(await fetchJson(url), externalId, LOCALE);
}

module.exports = {
  id: 'xbox',
  label: 'Xbox',
  search,
  detail,
  imageHostAllowed,
  // exported for unit tests:
  parseSearch,
  parseDetail,
  parsePlayers,
  pickImage,
};
