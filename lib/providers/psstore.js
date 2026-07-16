'use strict';

/*
 * PlayStation Store provider (digital games) for the add-game lookup.
 *
 * The PS Store has no official public API. What it does have is a normal,
 * server-rendered storefront: each search/product page ships its data as a
 * Next.js `__NEXT_DATA__` JSON blob (a normalized Apollo cache). We fetch that
 * page server-side and read the blob — no auth, no API key. This is effectively
 * scraping an undocumented internal structure: it can break if Sony changes the
 * page, so every parser degrades to null/empty rather than throwing.
 *
 * What the store gives us cleanly: title, cover image, a product id, and a link.
 * Player counts are only in the rendered product-page markup (best-effort
 * scrape); play duration is not a PlayStation concept at all, so `duration` is
 * always null and left to manual entry.
 *
 * The pure parsers are exported for unit tests (no network needed).
 */

const BASE = 'https://store.playstation.com';
// The store is localized; default to the German store (German UI) but allow an
// override. Format is like 'de-de' or 'en-us'.
const LOCALE = process.env.PSSTORE_LOCALE || 'de-de';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 10000;

// Cover images live on Sony's image CDN; the games route only downloads images
// whose host is on a provider's allowlist (a small SSRF guard).
const IMAGE_HOSTS = ['image.api.playstation.com', 'playstation.net'];

// Cover art we prefer, best first. Falls back to any IMAGE-type media.
const IMAGE_ROLES = ['GAMEHUB_COVER_ART', 'MASTER', 'EDITION_KEY_ART', 'PORTRAIT_BANNER'];

// Pull the __NEXT_DATA__ JSON blob out of a store HTML page, or null.
function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Walk a parsed structure collecting Apollo `Product` objects, deduped by name,
// preserving encounter order. On search pages set fullGameOnly to drop DLC and
// bundles; product pages carry only a bare Product stub with no classification,
// so detail parsing keeps them all.
function collectProducts(node, out, seen, fullGameOnly) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) collectProducts(v, out, seen, fullGameOnly);
    return;
  }
  if (
    node.__typename === 'Product' &&
    node.name &&
    (!fullGameOnly || node.storeDisplayClassification === 'FULL_GAME') &&
    !seen.has(node.name)
  ) {
    seen.add(node.name);
    out.push(node);
  }
  for (const v of Object.values(node)) collectProducts(v, out, seen, fullGameOnly);
}

// Choose the best cover image URL from a Product's media array, or null.
function pickImage(media) {
  if (!Array.isArray(media)) return null;
  const images = media.filter((m) => m && m.type === 'IMAGE' && m.url);
  for (const role of IMAGE_ROLES) {
    const hit = images.find((m) => m.role === role);
    if (hit) return hit.url;
  }
  return images.length ? images[0].url : null;
}

// Parse a search page into [{ providerId, title, thumbnail }].
function parseSearch(html, limit = 8) {
  const data = extractNextData(html);
  if (!data) return [];
  const products = [];
  collectProducts(data, products, new Set(), true); // full games only
  return products.slice(0, limit).map((p) => ({
    providerId: p.id,
    title: p.name,
    thumbnail: pickImage(p.media),
  }));
}

// Parse the local player-count spec out of the product page markup. The store
// renders it in a compatibility notice as e.g. `compatText">1 - 4 players</span>`
// (en-US) or `compatText">1 – 4 Spieler</span>` (de-DE, note the en-dash). The
// number(s) must sit immediately before the players word, which excludes the
// separate "N Online-Spieler" / "N Online players" notice. Returns { min, max }
// (max may equal min), or { min: null, max: null } if none is found.
function parsePlayers(html) {
  const re = /compatText">\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*(?:players?|Spieler)\b/gi;
  let best = null;
  let m;
  while ((m = re.exec(html)) !== null) {
    const min = parseInt(m[1], 10);
    const max = m[2] ? parseInt(m[2], 10) : min;
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) continue;
    // Prefer the widest range (captures "1 - 4" over a bare "4 players").
    if (!best || max - min > best.max - best.min) best = { min, max };
  }
  return best || { min: null, max: null };
}

// Parse a product page into a normalized detail object. Product pages carry only
// a minimal Product stub (id + name, no media/classification) — the cover comes
// from the search result — so this may return null image and just adds the
// digital type, the player count (scraped) and the source url. Never null.
function parseProduct(html, productId, locale = LOCALE) {
  const data = extractNextData(html);
  let product = null;
  if (data) {
    const products = [];
    collectProducts(data, products, new Set(), false);
    product = products.find((p) => p.id === productId) || products[0] || null;
  }
  const { min, max } = parsePlayers(html);
  return {
    provider: 'psstore',
    externalId: productId,
    title: product ? product.name || null : null,
    minPlayers: min,
    maxPlayers: max,
    type: 'digital',
    // The PS Store exposes no play-time; default digital titles to the long
    // bucket, which is almost always the right one (matches the Nintendo eShop
    // default). Pre-selects "long" in the add-game sheet.
    duration: 'long',
    imageUrl: product ? pickImage(product.media) : null,
    url: `${BASE}/${locale}/product/${productId}`,
  };
}

// True if url points at a Sony image host (used to gate the cover download).
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

// Fetch a URL as text with a browser-like UA and a timeout. Throws on non-2xx.
async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': LOCALE },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`PS Store responded ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function search(query, limit = 8) {
  const url = `${BASE}/${LOCALE}/search/${encodeURIComponent(query)}`;
  return parseSearch(await fetchText(url), limit);
}

async function detail(externalId) {
  const url = `${BASE}/${LOCALE}/product/${encodeURIComponent(externalId)}`;
  return parseProduct(await fetchText(url), externalId, LOCALE);
}

module.exports = {
  id: 'psstore',
  label: 'PlayStation Store',
  search,
  detail,
  imageHostAllowed,
  imageHosts: IMAGE_HOSTS, // trusted cover hosts (feeds the CSP img-src allowlist)
  // exported for unit tests:
  extractNextData,
  parseSearch,
  parseProduct,
  parsePlayers,
  pickImage,
};
