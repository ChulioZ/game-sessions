/* Spielwirbel – client-side routing. Maps the URL to a view and back, so a
   reload keeps the current screen and stable views are shareable by link.
   Part of the frontend; all files share one global script scope (load order:
   see index.html). Uses the History API (clean paths, no hash); the server
   serves index.html for these paths (SPA fallback in lib/app.js).

   The stable views call syncUrl() at their start to reflect themselves in the
   URL. The transient voting/finale/start-session screens hold unsaved local
   state, so they can't be rebuilt from a path: they push history entries like
   everything else (#329) but re-render themselves from memory via a *flow*
   (below), and cold-loading such a URL falls back to the round hub. */

'use strict';

// True only while the router itself is driving navigation (cold load or a
// Back/Forward popstate). In that case the resolved view must *replace* the
// current history entry instead of pushing a new one — pushing would corrupt
// Back/Forward and add phantom entries when a path normalizes (e.g.
// /round/:rid/start -> /round/:rid).
let routing = false;

// Monotonic index of the current history entry within *this app's* navigation.
// It starts at 0 for the entry we load into, and increments only when we push a
// new entry (a genuine forward navigation). Stored in each entry's state so a
// Back/Forward restores the right index. navBack() uses it to tell "there is an
// earlier in-app view to go back to" (idx > 0) from "this is the entry we
// cold-loaded into" (idx === 0), so a deep link's Back falls back to a parent
// instead of leaving the app.
let navIndex = 0;

// A *flow* is a run of history entries whose screens hold unsaved in-memory
// state and therefore cannot be re-rendered from their URL (today: the session
// flow — setup, hot-seat voting steps, finale). While one is registered it gets
// first refusal on popstate and re-renders its own step from memory; anything
// it doesn't recognise ends it and routes normally. A cold load registers no
// flow, so those URLs fall through to resolveRoute() and land on the hub.
let activeFlow = null;
// Optional companion predicate: "may the user leave this flow right now?".
// Answering false aborts the navigation (e.g. votes would be discarded).
let activeGuard = null;

function beginFlow(onPopstate, guard) {
  activeFlow = onPopstate;
  activeGuard = guard || null;
}

function endFlow() {
  activeFlow = null;
  activeGuard = null;
}

// Called by every in-app exit that could abandon a flow (the top-bar home
// button, the flow's own "Zurück" button, a Back that leaves it). Returns false to
// abort the navigation; on a permitted leave it also ends the flow, so callers
// only ever write `if (confirmLeave()) …`. The guard does its own teardown —
// it is the only thing that knows what "unsaved" means for that screen.
function confirmLeave() {
  if (activeGuard && !activeGuard()) return false;
  endFlow();
  return true;
}

// Canonical paths for the routable views. A view syncs its URL through these,
// and since #330 the navigation elements pointing at that view carry the same
// path as a real href — so "where does this control go?" is answered in one
// place instead of being spelled out at each call site.
// (The *transient* session-flow paths live in session-path.js: they are
// deliberately not resolvable, so they are not link targets either.)

// A round, or one of its sub-screens — the four hub tabs plus retired /
// completed / design / tags / providers. The Start tab has the bare round URL.
function roundPath(rid, sub) {
  return sub && sub !== 'start' ? `/round/${rid}/${sub}` : `/round/${rid}`;
}
const gamePath = (rid, gid) => `/round/${rid}/game/${gid}`;
const memberPath = (rid, mid) => `/round/${rid}/member/${mid}`;
const resultsPath = (rid, sid) => `/round/${rid}/session/${sid}`;

// Reflect the current view in the URL. Called synchronously at the start of
// each routable show*(). While the router is driving (routing === true) or the
// path already matches, it replaces; otherwise it pushes a new history entry.
function syncUrl(path) {
  // Every view calls this first, so it doubles as the navigation signal for
  // the SWR cache: bumping the token retires any background refresh armed by
  // the previous view (core.js swrRead) — a late response updates the cache
  // but must never re-render a view the user already left.
  swrRenderToken += 1;
  if (routing || path === location.pathname) {
    history.replaceState({ path, idx: navIndex }, '', path);
  } else {
    navIndex += 1;
    history.pushState({ path, idx: navIndex }, '', path);
  }
}

// Generic "Zurück": return to the previous in-app view. If there is one
// (navIndex > 0, i.e. we pushed at least one entry to get here) go back through
// history — which restores the exact previous view, tab and scroll position,
// and stays consistent with the browser's Back button. Otherwise (a cold-loaded
// deep link with no in-app history behind it) run the caller's fallback so we
// land on a sensible parent instead of leaving the app.
function navBack(fallback) {
  if (navIndex > 0) {
    history.back();
  } else if (typeof fallback === 'function') {
    fallback();
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
    if (sub === 'completed') return () => showCompleted(rid);
    if (sub === 'design') return () => showBackground(rid);
    if (sub === 'tags') return () => showTags(rid);
    if (sub === 'providers') return () => showProviders(rid);
    if (sub === 'game' && parts[3]) return () => showGameDetail(rid, parts[3]);
    if (sub === 'member' && parts[3]) return () => showMember(rid, parts[3]);
    if (sub === 'session' && parts[3]) {
      // The flow's transient screens (…/session/new, …/vote/:step, …/finale)
      // hold votes that only ever lived in memory, so a cold load can't restore
      // one — and neither can any other unknown sub-path. Land on the round hub
      // instead, where an abandoned draw is offered as an in-progress ticket.
      if (parts[3] === 'new' || parts[4]) return () => showRound(rid, 'start');
      return () => showResultsById(rid, parts[3]);
    }
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
    round = await fetchRound(rid);
  } catch {
    return showHome();
  }
  const session = round.sessions.find((s) => s.id === sid);
  if (!session) return showRound(rid, 'start');
  showResults(round, session);
}

// Back/Forward: the browser has already updated location, so restore our index
// from the entry we landed on, then just re-render it. An active flow gets the
// entry first — it can rebuild its own step from memory, which routeTo() never
// could — and only a path it declines falls through to normal routing.
window.addEventListener('popstate', (e) => {
  navIndex = (e.state && typeof e.state.idx === 'number') ? e.state.idx : 0;
  // A sheet's marker gets first refusal (#333): if a sheet is open this pop is
  // Back dismissing it; if we still owe a pushed marker this pop is that marker
  // being consumed after a programmatic close. Either way the router swallows it.
  if (handleSheetPop()) return;
  if (activeFlow && activeFlow(location.pathname)) return;
  endFlow();
  routeTo(location.pathname);
});
