'use strict';

/*
 * Service worker (issue #142): makes the SPA installable and usable offline.
 *
 * Strategy — deliberately minimal, no build step required (matches the app's
 * no-bundler stance):
 *  - Precache the static app shell on install (HTML/CSS/JS/manifest/icons).
 *  - Navigations: network-first, falling back to the cached shell offline, so an
 *    online visit always hits the server (which decides the auth gate, #129) and
 *    only offline serves the cached shell.
 *  - Other same-origin assets: cache-first (fast repeat loads, offline capable).
 *  - /api/ and /uploads/ are NEVER cached — API responses are live data and
 *    /uploads/ is auth-gated user cover art; both must always go to the network.
 *
 * CACHE version: bump it whenever a shell asset changes, so the cache-first
 * assets don't serve stale JS/CSS — a new name re-precaches the shell and
 * `activate` drops the old cache. NOTE: the optional production build
 * (`npm run build`, #141) content-hashes the js/css AND rewrites this literal to
 * a content-derived name, so a *built* deploy self-invalidates. This manual `vN`
 * bump only matters when serving the unbuilt public/ tree (dev / a non-prod
 * deploy). See .claude/rules/frontend-build-cache-busting.md.
 */

const CACHE = 'spielwirbel-shell-v19';

// Everything the app needs to boot offline. Kept in sync with the <script>/<link>
// order in index.html; each entry must be a real, servable path or install fails
// (cache.addAll rejects on any 404). Fonts' own woff2 files are picked up lazily
// by the cache-first handler on first use rather than listed here.
const SHELL = [
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/fonts/tabler-icons.css',
  '/js/i18n.js',
  '/js/lang/en.js',
  '/js/lang/de.js',
  '/js/cover.js',
  '/js/cover-size.js',
  '/js/tag-icons.js',
  '/js/swr.js',
  '/js/focus-trap.js',
  '/js/core.js',
  '/js/account.js',
  '/js/ranking.js',
  '/js/lookup-group.js',
  '/js/lookup-cover.js',
  '/js/feedback.js',
  '/js/views-home.js',
  '/js/views-round.js',
  '/js/views-round-tabs.js',
  '/js/views-round-detail.js',
  '/js/views-round-lookup.js',
  '/js/views-member.js',
  '/js/views-session.js',
  '/js/router.js',
  '/js/main.js',
  '/js/pwa.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function networkFirstShell(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE);
    const cached = await cache.match('/index.html');
    return cached || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // Only store our own successful, non-opaque responses.
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // never intercept mutations
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave cross-origin to the network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return; // live data / gated covers

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});
