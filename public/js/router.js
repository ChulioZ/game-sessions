/* Spieleabend – client-side routing. Maps the URL to a view and back, so a
   reload keeps the current screen and stable views are shareable by link.
   Part of the frontend; all files share one global script scope (load order:
   see index.html). Uses the History API (clean paths, no hash); the server
   serves index.html for these paths (SPA fallback in lib/app.js).

   The stable views call syncUrl() at their start to reflect themselves in the
   URL. The transient voting/finale/start-session screens are intentionally not
   routed (they hold unsaved local state); cold-loading such a URL falls back to
   the round hub. */

'use strict';

// True only while the router itself is driving navigation (cold load or a
// Back/Forward popstate). In that case the resolved view must *replace* the
// current history entry instead of pushing a new one — pushing would corrupt
// Back/Forward and add phantom entries when a path normalizes (e.g.
// /round/:rid/start -> /round/:rid).
let routing = false;

// Canonical path for the round hub: the Start tab has the bare round URL.
function roundPath(rid, tab) {
  return tab && tab !== 'start' ? `/round/${rid}/${tab}` : `/round/${rid}`;
}

// Reflect the current view in the URL. Called synchronously at the start of
// each routable show*(). While the router is driving (routing === true) or the
// path already matches, it replaces; otherwise it pushes a new history entry.
function syncUrl(path) {
  if (routing || path === location.pathname) {
    history.replaceState({ path }, '', path);
  } else {
    history.pushState({ path }, '', path);
  }
}

// Map a URL path to the view that renders it. Returns a zero-arg function that
// invokes the matching show*(); unknown paths fall back to Home. Routes for the
// transient voting/finale screens deliberately don't exist, so their (stale)
// URLs resolve to the round hub or Home here.
function resolveRoute(pathname) {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return () => showHome();
  if (parts[0] === 'round') {
    if (parts[1] === 'new') return () => showNewRound();
    const rid = parts[1];
    if (!rid) return () => showHome();
    const sub = parts[2];
    if (!sub || sub === 'start') return () => showRound(rid, 'start');
    if (['regal', 'chronik', 'pokale'].includes(sub)) return () => showRound(rid, sub);
    if (sub === 'retired') return () => showRetired(rid);
    if (sub === 'design') return () => showBackground(rid);
    if (sub === 'game' && parts[3]) return () => showGameDetail(rid, parts[3]);
    if (sub === 'member' && parts[3]) return () => showMember(rid, parts[3]);
    if (sub === 'session' && parts[3]) return () => showResultsById(rid, parts[3]);
    // Unknown sub-path under a round -> that round's hub.
    return () => showRound(rid, 'start');
  }
  return () => showHome();
}

// Render the view for a URL path (cold load and Back/Forward). `routing` makes
// the resolved view replace rather than push, so history stays consistent.
function routeTo(pathname) {
  routing = true;
  try {
    resolveRoute(pathname)();
  } finally {
    routing = false;
  }
}

// Cold-load a finished session's results from IDs alone (showResults normally
// receives full objects). Falls back gracefully if the round or session is gone.
async function showResultsById(rid, sid) {
  let round;
  try {
    round = await api('GET', '/api/rounds/' + rid);
  } catch {
    return showHome();
  }
  const session = round.sessions.find((s) => s.id === sid);
  if (!session) return showRound(rid, 'start');
  showResults(round, session);
}

// Back/Forward: the browser has already updated location, so just re-render it.
window.addEventListener('popstate', () => routeTo(location.pathname));
