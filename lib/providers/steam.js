'use strict';

/*
 * Steam provider (digital PC games) for the add-game lookup.
 *
 * Unlike the console stores, Steam exposes near-official, key-free JSON
 * endpoints behind the storefront, so this provider talks JSON on both hops
 * (like the BGG detail call) rather than scraping an HTML page:
 *
 *   - search: store.steampowered.com/api/storesearch — returns
 *     { items: [{ type, id (appid), name, tiny_image }] }. We keep only
 *     type 'app' (drops 'sub'/'bundle' packages) and map to
 *     { providerId, title, thumbnail }.
 *   - detail: store.steampowered.com/api/appdetails?appids=<id> — returns
 *     { <id>: { success, data: { name, header_image, categories, … } } }.
 *
 * These are undocumented/store-facing, so every parser degrades to null/empty
 * instead of throwing. Steam has no player-count field; player count is inferred
 * best-effort from the (locale-independent) category ids. The pure parsers are
 * exported for unit tests (no network needed).
 */

const BASE = 'https://store.steampowered.com';
// Steam localizes prices/text by country code + language; default to the German
// store, both overridable (e.g. STEAM_CC=us, STEAM_LOCALE=english).
const CC = process.env.STEAM_CC || 'de';
const LOCALE = process.env.STEAM_LOCALE || 'german';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 10000;

// Cover images live on Steam's CDN (shared.akamai.steamstatic.com,
// cdn.cloudflare.steamstatic.com, …); the games route only downloads images
// whose host is on a provider's allowlist (a small SSRF guard).
const IMAGE_HOSTS = ['steamstatic.com'];

// Steam store "category" ids are stable across languages (the descriptions are
// localized, the ids are not). Any of these implies more than one player;
// category 2 is Single-player. Covers Multi-player, Co-op and PvP variants.
const MULTIPLAYER_CATEGORY_IDS = new Set([1, 9, 27, 36, 37, 38, 39, 47, 48, 49]);
const SINGLE_PLAYER_CATEGORY_ID = 2;

// Choose the best cover image URL from an appdetails data object, or null.
// header_image is Steam's canonical store cover; capsule_image is the fallback.
function pickImage(data) {
  if (!data || typeof data !== 'object') return null;
  for (const url of [data.header_image, data.capsule_image]) {
    if (typeof url === 'string' && url) return url;
  }
  return null;
}

// Parse a storesearch JSON response into [{ providerId, title, thumbnail }].
// Keeps only full games (type 'app'), dropping 'sub'/'bundle' packages. Deduped
// by appid; entries without an id or name are skipped. Never throws.
function parseSearch(json, limit = 8) {
  const items = json && Array.isArray(json.items) ? json.items : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || item.type !== 'app') continue;
    const id = item.id != null ? String(item.id) : '';
    const title = item.name ? String(item.name) : '';
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    out.push({
      providerId: id,
      title,
      thumbnail: typeof item.tiny_image === 'string' && item.tiny_image ? item.tiny_image : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Infer a best-effort { min, max } player count from an appdetails categories
// array. Steam exposes no numeric counts, only category flags, so: a
// multiplayer category => { min: 1, max: null } (upper bound unknown, never
// invented); otherwise single-player only => { min: 1, max: 1 }; neither =>
// { min: null, max: null }.
function parsePlayers(categories) {
  const list = Array.isArray(categories) ? categories : [];
  let multiplayer = false;
  let singleplayer = false;
  for (const c of list) {
    const cid = c && c.id != null ? parseInt(c.id, 10) : NaN;
    if (MULTIPLAYER_CATEGORY_IDS.has(cid)) multiplayer = true;
    if (cid === SINGLE_PLAYER_CATEGORY_ID) singleplayer = true;
  }
  if (multiplayer) return { min: 1, max: null };
  if (singleplayer) return { min: 1, max: 1 };
  return { min: null, max: null };
}

// Parse an appdetails JSON response into a normalized detail object. Never null
// (mirrors the other providers): a missing/failed entry yields the same shape
// with null fields, so the "View on Steam" link still works.
function parseAppDetails(json, appId) {
  const entry = json && typeof json === 'object' ? json[String(appId)] : null;
  const data = entry && entry.success && entry.data && typeof entry.data === 'object' ? entry.data : null;
  const { min, max } = parsePlayers(data && data.categories);
  return {
    provider: 'steam',
    externalId: String(appId),
    title: data && data.name ? String(data.name) : null,
    minPlayers: min,
    maxPlayers: max,
    type: 'digital',
    imageUrl: pickImage(data),
    url: `${BASE}/app/${encodeURIComponent(appId)}/`,
  };
}

// True if url points at a Steam image host (used to gate the cover download).
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
    if (!res.ok) throw new Error(`Steam responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function search(query, limit = 8) {
  const params = new URLSearchParams({ term: query, cc: CC, l: LOCALE });
  return parseSearch(await fetchJson(`${BASE}/api/storesearch/?${params.toString()}`), limit);
}

async function detail(externalId) {
  const params = new URLSearchParams({ appids: externalId, cc: CC, l: LOCALE });
  return parseAppDetails(await fetchJson(`${BASE}/api/appdetails?${params.toString()}`), externalId);
}

module.exports = {
  id: 'steam',
  label: 'Steam',
  search,
  detail,
  imageHostAllowed,
  imageHosts: IMAGE_HOSTS, // trusted cover hosts (feeds the CSP img-src allowlist)
  // exported for unit tests:
  parseSearch,
  parseAppDetails,
  parsePlayers,
  pickImage,
};
