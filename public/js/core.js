/* Spielwirbel – core: DOM helpers, API, small utilities, stats,
   design application. Part of the frontend; all files share one global script
   scope. Load order: see index.html. */

'use strict';

const app = document.getElementById('app');
const crumbs = document.getElementById('crumbs');
const toastEl = document.getElementById('toast');

// Arrow so showHome (defined in a later script) is only resolved on click –
// it does not exist yet while core.js is loading.
document.getElementById('homeBtn').addEventListener('click', () => showHome());

// Re-invoked when the language changes, to re-render the current screen.
let currentView = () => showHome();

// ---- small helpers ---------------------------------------------------------

const h = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

// Toasts carry confirmations AND errors, so they must reach a screen reader
// (#145). The element is an aria-live region declared in index.html, and it must
// stay in the accessibility tree permanently for that to work: a live region
// that is inserted (or un-`hidden`) with its text already in place is NOT
// announced. So visibility is a class, never the `hidden` attribute — the empty
// region sits in the tree and only its text content changes, which is exactly
// the mutation aria-live listens for.
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('is-on');
    // Clear the text too, so the next identical message is still a change the
    // live region reports rather than a no-op mutation.
    toastEl.textContent = '';
  }, 2200);
}

async function api(method, url, body, _retried) {
  const opts = { method, headers: {} };
  // Accounts mode (#138): attach the account access token. getAccessToken() is
  // null in legacy/shared-password mode, so this is a no-op there.
  const token = getAccessToken();
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = 'Error';
    let payload;
    try { payload = await res.json(); msg = payload.error || msg; } catch {}
    // Session expired or missing while a gate is on. In accounts mode (#138) try
    // a silent token refresh once and retry, then fall back to the login screen;
    // in legacy shared-password mode (issue #129) bounce to '/', which the server
    // serves the login page for when locked.
    if (res.status === 401 && payload && payload.error === 'auth_required') {
      if (accountsActive()) {
        if (!_retried && (await refreshAccessToken())) return api(method, url, body, true);
        onSessionLost();
      } else {
        // Locked out of the shared-password gate: drop the persisted cache
        // before bouncing, so the login page never fronts stale round data.
        invalidateRoundCache();
        window.location.assign('/');
      }
    }
    throw new Error(msg);
  }
  // Any successful mutation may change round data, so drop the cached round —
  // the next navigation re-fetches fresh. GETs (and failed calls, which threw
  // above) leave the cache alone. api() is the one chokepoint every request
  // goes through, which makes this invalidation airtight.
  if (method !== 'GET') invalidateRoundCache();
  return res.status === 204 ? null : res.json();
}

/* Stale-while-revalidate navigation cache (store: js/swr.js, loaded earlier).
 *
 * Every navigation used to block on a fresh fetch behind a "…" placeholder —
 * the dominant felt latency on the hosted deploy, where each data request
 * costs a full server round trip. Now a view renders INSTANTLY from the last
 * known data (persisted in localStorage, so even a cold app start paints
 * real content) while the fetch runs in the background; if it returns
 * something different, the current view re-renders once, silently.
 *
 * Correctness guards, all load-bearing:
 *  - api() clears the whole cache on every successful mutation (see above),
 *    so a post-mutation navigation always awaits fresh data — the user never
 *    sees their own change flash back to the old state. Stale renders can
 *    only show *another* device's lag, which the background refresh corrects.
 *  - A background refresh only re-renders while the SAME view instance is
 *    current (swrRenderToken, bumped by syncUrl on every navigation) and no
 *    sheet/popover is open (uiBusy) — never yanking UI out from under an
 *    interaction. A skipped re-render is fine: the cache is already fresh for
 *    the next navigation.
 *  - The re-rendered view re-reads the cache within the freshness window, so
 *    refresh -> re-render -> refresh can't loop (see swr.js beginRevalidate).
 *  - The auth flows (account.js) clear the store on login/logout/session
 *    loss, so no cached data survives an identity change.
 * Views never mutate returned objects in place (same contract as before). The
 * mid-session "must be fresh" fetches use fetchRoundFresh, which awaits the
 * network and seeds the cache. */
const SWR_FRESH_MS = 5000;
const swrStore = createSwrStore({
  storage: (() => { try { return window.localStorage; } catch { return null; } })(),
  storageKey: 'spielwirbel.swr.v1',
});
let swrRenderToken = 0; // bumped by syncUrl (router.js) on every navigation
function invalidateRoundCache() {
  swrStore.clear();
}
// True while a background re-render would destroy something the user is in
// the middle of: an open sheet/popover, or a focused form field anywhere in
// the app (member rename, tag creation, the Regal search box — a re-render
// replaces the node and eats the keystrokes). A skipped re-render is always
// safe: the cache is already fresh for the next navigation.
function uiBusy() {
  if (document.querySelector('.sheet-backdrop') || activePopover) return true;
  const el = document.activeElement;
  return !!el && app.contains(el) && el.matches('input, textarea, select');
}
// Serve the cached value for `key` (instantly, however old) and revalidate in
// the background; block only on a cache miss. `rerender: false` still refreshes
// the cache but never re-renders the view — for form screens, where a rebuild
// would wipe what the user is typing.
async function swrRead(key, url, { rerender = true } = {}) {
  const cached = swrStore.get(key);
  if (cached === undefined) {
    const value = await api('GET', url);
    swrStore.set(key, value);
    return value;
  }
  if (swrStore.beginRevalidate(key, SWR_FRESH_MS)) {
    const token = swrRenderToken;
    api('GET', url)
      .then((fresh) => {
        swrStore.endRevalidate(key);
        const changed = JSON.stringify(fresh) !== JSON.stringify(swrStore.get(key));
        swrStore.set(key, fresh);
        if (rerender && changed && token === swrRenderToken && !uiBusy()) currentView();
      })
      .catch(() => swrStore.endRevalidate(key));
  }
  return cached;
}
const fetchRoundList = (opts) => swrRead('rounds', '/api/rounds', opts);
const fetchRound = (rid) => swrRead('round:' + rid, '/api/rounds/' + rid);
// The activity feed lives on its own endpoint (#197), hence its own key.
const fetchActivities = (rid) => swrRead('acts:' + rid, `/api/rounds/${rid}/activities`);
// Await the network and seed the cache — for flows that must observe their own
// just-written state (mid-session refreshes) where a stale render would lie.
async function fetchRoundFresh(rid) {
  const round = await api('GET', '/api/rounds/' + rid);
  swrStore.set('round:' + rid, round);
  return round;
}

function setCrumbs(parts) {
  crumbs.innerHTML = '';
  parts.forEach((p, i) => {
    if (i > 0) crumbs.appendChild(h('<span class="sep">›</span>'));
    if (p.onClick) {
      const b = h(`<button class="link-btn">${esc(p.label)}</button>`);
      b.addEventListener('click', p.onClick);
      crumbs.appendChild(b);
    } else {
      crumbs.appendChild(h(`<span>${esc(p.label)}</span>`));
    }
  });
}

// Join names for the active language: "A", "A and B", "A, B and C".
function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' ' + t('list.and') + ' ' + names[names.length - 1];
}

// Texts that live outside the rendered views (top bar). Re-applied on language change.
function applyStaticTexts() {
  const home = document.getElementById('homeBtn');
  home.innerHTML =
    `<i class="ti ti-tornado" aria-hidden="true"></i> <span class="topbar__word">${esc(t('app.title'))}</span>`;
  // These controls are icon-only (or, for the picker, unlabelled), so the
  // aria-label is the ONLY thing a screen reader announces. index.html can only
  // carry one hardcoded language, so every one of them is localized here — this
  // runs on locale init AND on every change. Leaving the static markup in place
  // announced "Home"/"Language"/"Account" in English over an otherwise German UI
  // (#145); only the feedback button was being localized.
  home.setAttribute('aria-label', t('a11y.home'));
  document.getElementById('langPicker').setAttribute('aria-label', t('a11y.language'));
  document.getElementById('feedbackBtn').setAttribute('aria-label', t('feedback.button'));
  document.getElementById('accountBtn').setAttribute('aria-label', t('a11y.account'));
  crumbs.setAttribute('aria-label', t('a11y.breadcrumb'));
  // Shared site footer (issues #224/#134): link labels, re-localized on
  // language change like the aria-labels above.
  document.getElementById('footerKontakt').textContent = t('footer.contact');
  document.getElementById('footerImpressum').textContent = t('footer.impressum');
  document.getElementById('footerPrivacy').textContent = t('footer.privacy');
  document.getElementById('footerTerms').textContent = t('footer.terms');
}

// Shared site footer visibility (issues #224/#134). The footer starts hidden in
// the markup and is shown only when the server says the public surfaces behind
// it are configured (GET /api/config — mail delivery for Kontakt AND the
// Impressum address for the legal pages). All-or-nothing by design: a
// half-ready instance shows no footer rather than a broken one. Plain fetch
// (not api()): the endpoint is public and a failure must never bounce to login
// — on any error the footer just stays hidden.
function initFooter() {
  fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (cfg && cfg.footer) document.querySelector('.site-footer').hidden = false;
    })
    .catch(() => {});
}

// Language picker in the top bar.
function setupLangPicker() {
  const sel = document.getElementById('langPicker');
  sel.innerHTML = SUPPORTED_LOCALES.map(
    (loc) => `<option value="${loc}">${LOCALE_LABELS[loc]}</option>`
  ).join('');
  sel.value = getLocale();
  sel.addEventListener('change', () => {
    setLocale(sel.value);
    applyStaticTexts();
    currentView(); // re-render the current screen in the new language
  });
}

// Games list sorting – kept for the running session. Defaults to rating
// (best first); the per-round reset in renderRegalTab re-applies this default.
let gamesSort = 'avg';
// Regal filter state – kept for the running session, scoped to one round.
// Reset (along with gamesSort) when a different round's Regal is opened.
// `tags` is a tri-state Map<tagId, 'include'|'exclude'> (#241); absence = ignore.
let regalFilters = { tags: new Map(), query: '' };
let regalFiltersRid = null;

// Tri-state custom-tag filter (#241), shared by the Regal and start-session tag
// chips. State lives in a Map<tagId, 'include'|'exclude'> — a tag absent from the
// map is ignored. Clicking a chip cycles ignore -> include -> exclude -> ignore.
const TAG_STATES = [undefined, 'include', 'exclude'];
// Advance one tag to its next state in the cycle, mutating the map, and return
// the new state (undefined = back to ignore, so the entry is removed).
function cycleTagState(map, id) {
  const next = TAG_STATES[(TAG_STATES.indexOf(map.get(id)) + 1) % TAG_STATES.length];
  if (next) map.set(id, next);
  else map.delete(id);
  return next;
}
// Reflect a tag chip's state on its element: the fill class, the glyph (a ban
// icon for exclude), and an accessible label so include vs exclude is
// distinguishable without relying on color alone (a11y).
function paintTagChip(chip, name, state, tagIcon) {
  chip.classList.toggle('is-on', state === 'include');
  chip.classList.toggle('is-excluded', state === 'exclude');
  // The ban glyph still wins for the exclude state (#255): it conveys filter
  // semantics, not tag identity, and losing it would make include/exclude
  // indistinguishable without color.
  const icon = state === 'exclude' ? 'ti-ban' : tagIconClass(tagIcon);
  const key =
    state === 'include' ? 'tags.filter.included'
    : state === 'exclude' ? 'tags.filter.excluded'
    : 'tags.filter.ignored';
  chip.setAttribute('aria-label', t(key, { name }));
  chip.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i>${esc(name)}`;
}
// Build the curated tag-icon picker (#255): a grid of glyph buttons, exactly
// one active, following the MEMBER_COLORS swatch pattern (a fixed set, no free
// input). Since #293 the grid is collapsed behind a trigger showing the current
// glyph — 20 always-open buttons dominated the narrow tag popover, making an
// optional nicety read as the main task.
// Returns { trigger, grid, get }: the two parts are handed back separately, not
// as one wrapper, because every call site wants the trigger inline in an
// existing input row and the grid on its own line below it — a wrapper would
// force the grid into that row's flex layout. `get()` reads the current pick, so
// a caller can create/patch a tag with whatever is selected at submit time.
// `selected` is the tag's stored icon (or null/undefined for an unset one,
// which lands on the default `tags` glyph — the same one it already renders).
// `opts.expanded` drops the trigger entirely and renders the bare grid: the
// Tags screen's per-tag edit already toggles the picker open from its own pencil
// button, and nesting a second disclosure inside that would be one click too many.
let iconPickerSeq = 0;
function tagIconPicker(selected, opts) {
  let current = TAG_ICONS.includes(selected) ? selected : 'tags';
  const expanded = !!(opts && opts.expanded);
  const gridId = `icon-picker-${++iconPickerSeq}`;
  const grid = h(`<div class="icon-picker" id="${gridId}" role="group" aria-label="${esc(t('tags.chooseIcon'))}"${expanded ? '' : ' hidden'}></div>`);
  const trigger = expanded ? null : h(`<button type="button" class="icon-picker__trigger" aria-expanded="false"
       aria-controls="${gridId}" title="${esc(t('tags.chooseIcon'))}" aria-label="${esc(t('tags.chooseIcon'))}">
       <i class="ti ${tagIconClass(current)}" aria-hidden="true"></i>
       <i class="ti ti-chevron-down icon-picker__caret" aria-hidden="true"></i>
     </button>`);
  const setOpen = (open) => {
    grid.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };
  if (trigger) trigger.addEventListener('click', () => setOpen(grid.hidden));
  TAG_ICONS.forEach((key) => {
    const label = t(`tags.icons.${key}`);
    // data-icon carries the key so a caller can read it off the button it was
    // clicked on, rather than inferring it from the button's position.
    const btn = h(`<button type="button" class="icon-picker__btn${key === current ? ' is-active' : ''}"
         data-icon="${esc(key)}" title="${esc(label)}" aria-label="${esc(label)}" aria-pressed="${key === current}">
         <i class="ti ${tagIconClass(key)}" aria-hidden="true"></i>
       </button>`);
    btn.addEventListener('click', () => {
      current = key;
      grid.querySelectorAll('.icon-picker__btn').forEach((b) => {
        b.classList.remove('is-active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('is-active');
      btn.setAttribute('aria-pressed', 'true');
      if (trigger) {
        trigger.querySelector('.ti').className = `ti ${tagIconClass(key)}`;
        setOpen(false);
      }
    });
    grid.appendChild(btn);
  });
  return { trigger, grid, get: () => current };
}

// A game passes the tri-state tag filter iff it carries every included tag (AND)
// and none of the excluded tags. `map` is Map<tagId, 'include'|'exclude'>.
function matchesTagFilter(map, gameTagIds) {
  const ids = gameTagIds || [];
  for (const [id, state] of map) {
    if (state === 'include' && !ids.includes(id)) return false;
    if (state === 'exclude' && ids.includes(id)) return false;
  }
  return true;
}
// Remembered random order per round, so it stays the same when navigating back.
const randomOrderCache = {};
function randomOrderedGames(round, activeGames) {
  const ids = activeGames.map((g) => g.id);
  const cached = randomOrderCache[round.id];
  const sameSet = cached && cached.length === ids.length && ids.every((id) => cached.includes(id));
  const order = sameSet ? cached : (randomOrderCache[round.id] = shuffled(ids));
  return order.map((id) => activeGames.find((g) => g.id === id)).filter(Boolean);
}

// Rating stats of a game within ONE session.
function gameStatsForSession(round, session, gameId) {
  const ratings = [];
  let sortCount = 0;
  round.members.forEach((m) => {
    const v = (session.votes[m.id] || {})[gameId];
    if (!v) return;
    if (v.retire) sortCount++;
    if (typeof v.rating === 'number') ratings.push(v.rating);
  });
  const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  return { avg, count: ratings.length, sortCount };
}

// Rating stats of a game across ALL (still existing) sessions. Computed on
// demand on purpose: sessions are the single source of truth, so deleting a
// session automatically removes its effect.
function gameStats(round, gameId) {
  const ratings = [];
  let sortCount = 0;
  let sessions = 0;
  let votesCast = 0; // total votes cast (rating and/or "retire")
  round.sessions.forEach((s) => {
    if (!s.gameIds.includes(gameId)) return;
    sessions++;
    round.members.forEach((m) => {
      const v = (s.votes[m.id] || {})[gameId];
      if (!v) return;
      votesCast++;
      if (v.retire) sortCount++;
      if (typeof v.rating === 'number') ratings.push(v.rating);
    });
  });
  const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  return { avg, count: ratings.length, sortCount, sessions, votesCast };
}

// Retirement suggestions: games often suggested for retirement and/or with a
// very low average. Thresholds chosen so nothing is suggested until there are
// enough votes (no false alarm from a few votes).
function retireRecommendations(activeGames, statsByGame, minVotes) {
  const SORT_SHARE = 0.5; // at least half want it retired
  const LOW_AVG = 2.0; // "very low" on the 1–5 scale
  const recs = [];
  activeGames.forEach((g) => {
    const st = statsByGame[g.id];
    if (!st || st.votesCast < minVotes) return;
    const share = st.votesCast ? st.sortCount / st.votesCast : 0;
    const reasons = [];
    if (share >= SORT_SHARE)
      reasons.push(t('rec.reasonSort', { n: st.sortCount, pct: Math.round(share * 100) }));
    if (st.avg !== null && st.avg <= LOW_AVG)
      reasons.push(t('rec.reasonAvg', { avg: st.avg.toFixed(1) }));
    if (!reasons.length) return;
    const severity = share + (st.avg !== null ? Math.max(0, 3 - st.avg) / 3 : 0);
    recs.push({ game: g, reasons, severity });
  });
  recs.sort((a, b) => b.severity - a.severity);
  return recs;
}

// Recommendation box minimized for this session (per round).
const minimizedRecs = new Set();

// ---- Design ----

const STANDARD_ACCENT = '#c2410c';

// The accent a stored design should actually paint with. Rounds save a snapshot
// of the palette, so when a theme's accent is corrected — as Sand and Pfirsich
// were for contrast (#145) — a round that picked it earlier still carries the
// old, failing value. Resolving against the current THEMES on every render fixes
// those rounds the next time they are drawn, which is the same render-time (not
// capture-time) approach cover sizing takes and keeps the repo free of one-time
// migration code (CLAUDE.md). An unknown page — a legacy or hand-edited design —
// keeps whatever was stored. THEMES lives in a later-loaded file and is only
// read here at call time, which the load order allows.
function resolveAccent(bg) {
  const theme = THEMES.find((th) => th.page.toLowerCase() === String(bg.page).toLowerCase());
  return theme ? theme.accent : bg.accent;
}

// Apply the round's design: page background + accent color. Everything else —
// placeholders, borders, accent surfaces, the page glow and the finale stage —
// derives from these two custom properties via CSS color-mix (see styles.css).
function applyBackground(bg) {
  const root = document.documentElement.style;
  if (bg && bg.type === 'theme' && bg.page && bg.accent) {
    root.setProperty('--page-bg', bg.page);
    root.setProperty('--brand', resolveAccent(bg));
  } else if (bg && bg.type === 'color' && bg.color) {
    // Legacy stored design: only a page color, standard accent.
    root.setProperty('--page-bg', bg.color);
    root.removeProperty('--brand');
  } else {
    // No design -> fall back to the :root defaults.
    root.removeProperty('--page-bg');
    root.removeProperty('--brand');
  }
}

// Color for an average 1–5: red (bad) → yellow → green (good).
// The lightness is 30%, not the more obvious 42%, for contrast (#145): the scale
// is used BOTH as a fill under white text (.score-pill) and as text/stroke on the
// page (.gd-ring__num, the ring). At 42% the yellow-green middle only reached
// 2.4:1 under white — every rating badge in the app failed WCAG AA. 30% is the
// lightest value that clears 4.5:1 under white across the whole hue range (worst
// case 4.5 at avg 3.0) while the ring still clears the 3:1 large-text bar on
// every theme page. The hue is untouched, so the red→yellow→green reading is
// unchanged; don't lighten it back without re-checking both uses.
function avgColor(avg) {
  const hue = Math.max(0, Math.min(120, ((avg - 1) / 4) * 120));
  return `hsl(${hue}, 60%, 30%)`;
}

// Fixed, friendly palette for member avatars. A member keeps "their" color
// everywhere in the app; assignment is by position in round.members, which is
// append-only, so colors stay stable for the life of the round.
// Every entry carries white initials (.avatar, .nr-seat__avatar), so each one is
// tuned to clear 4.5:1 against white (#145 — the original palette sat at
// 3.4–3.9:1). Hues are the originals; six were darkened 7–15% to reach the bar,
// slate blue and berry already cleared it. Keep any new color at ≥4.5:1 on white.
const MEMBER_COLORS = [
  '#c6522c', // coral
  '#198663', // teal
  '#726bc7', // violet
  '#a66815', // amber
  '#c34d74', // pink
  '#2f6f9e', // slate blue
  '#54821d', // green
  '#993556', // berry
];
function memberColor(round, memberId) {
  const idx = round.members.findIndex((m) => m.id === memberId);
  // A stored color (set on the member's detail page) wins; otherwise the color
  // is derived from the member's position, which is append-only and stable.
  const m = idx >= 0 ? round.members[idx] : null;
  if (m && MEMBER_COLORS.includes(m.color)) return m.color;
  return MEMBER_COLORS[(idx >= 0 ? idx : 0) % MEMBER_COLORS.length];
}

// Initials for an avatar: first letters of the first two words, or the first
// two letters of a single-word name.
function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const raw = parts.length >= 2 ? parts[0][0] + parts[1][0] : String(name).trim().slice(0, 2);
  return raw.toUpperCase();
}

// Seat-picker around a table: tap a member to toggle whether they join tonight.
// `joining` is a Set of member ids, mutated in place; at least one member must
// stay in. `onChange` (optional) runs after a toggle. Returns the table element
// to append where needed. Shared by the start-session screen and the "Jetzt
// spielen" sheet.
function renderSeatPicker(round, joining, onChange) {
  const table = h(`<div class="nr-table">
      <div class="nr-table__ring"></div>
      <div class="nr-table__center"></div>
    </div>`);
  const tableCenter = table.querySelector('.nr-table__center');
  function render() {
    table.querySelectorAll('.nr-seat').forEach((el) => el.remove());
    tableCenter.textContent = t('startSession.tableCount', { n: joining.size });
    const cx = 140, cy = 118, rx = 112, ry = 92;
    round.members.forEach((m, i) => {
      const angle = ((-90 + (i * 360) / round.members.length) * Math.PI) / 180;
      const joined = joining.has(m.id);
      // aria-pressed carries the in/out state (#145). Without it the seat is
      // announced as a bare name and whether that member is playing tonight is
      // conveyed by color and a "+" glyph alone — unusable without sight, on the
      // control that decides who is in the session.
      const seat = h(`<button type="button" class="nr-seat${joined ? '' : ' nr-seat--out'}"
           aria-pressed="${joined}" title="${esc(m.name)}">
           <span class="nr-seat__avatar"${joined ? ` style="background:${memberColor(round, m.id)}"` : ''}>${
             joined ? esc(initials(m.name)) : '<i class="ti ti-plus" aria-hidden="true"></i>'
           }</span>
           <span class="nr-seat__name">${esc(m.name)}</span>
         </button>`);
      seat.style.left = cx + rx * Math.cos(angle) + 'px';
      seat.style.top = cy + ry * Math.sin(angle) - 23 + 'px';
      seat.addEventListener('click', () => {
        if (joining.has(m.id)) {
          if (joining.size === 1) return toast(t('startSession.toast.noMembers'));
          joining.delete(m.id);
        } else {
          joining.add(m.id);
        }
        render();
        if (onChange) onChange();
      });
      table.appendChild(seat);
    });
  }
  render();
  return table;
}

// Accent color of a round's stored design (fallback: the standard accent).
// Works with both the full round object and the home-screen summary.
function themeAccent(bg) {
  // Same normalization as applyBackground, so a home-screen emblem never shows a
  // different accent than the round screen it opens.
  return bg && bg.type === 'theme' && bg.accent ? resolveAccent(bg) : STANDARD_ACCENT;
}

// --- Anchored popover (small floating menu next to a clicked element) ---
// Used for the inline edit menus on the game detail page. Only one is open at a
// time; it closes on Escape, an outside click, or a page scroll/resize.
let activePopover = null;
function closePopover() {
  if (!activePopover) return;
  activePopover.el.remove();
  document.removeEventListener('mousedown', activePopover.onDoc, true);
  document.removeEventListener('keydown', activePopover.onKey, true);
  window.removeEventListener('resize', activePopover.onGone, true);
  window.removeEventListener('scroll', activePopover.onScroll, true);
  activePopover = null;
}
function openPopover(anchor, build) {
  closePopover();
  const el = h('<div class="popover"></div>');
  const close = () => closePopover();
  build(el, close);
  document.body.appendChild(el);

  // Prefer below the anchor; flip above if it wouldn't fit. Clamp horizontally.
  const r = anchor.getBoundingClientRect();
  const margin = 8;
  const below = window.scrollY + r.bottom + 6;
  const above = window.scrollY + r.top - el.offsetHeight - 6;
  const fitsBelow = r.bottom + el.offsetHeight + 6 <= window.innerHeight;
  el.style.top = (fitsBelow || above < window.scrollY ? below : above) + 'px';
  let left = window.scrollX + r.left;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - el.offsetWidth - margin;
  left = Math.max(window.scrollX + margin, Math.min(left, maxLeft));
  el.style.left = left + 'px';

  const onDoc = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const onGone = () => close();
  // Capture-phase scroll on window also fires for scrolls *inside* the popover —
  // a single-line <input> scrolls as soon as its text overflows, which silently
  // closed the popover mid-typing (#247). Ignore those; a page scroll targets
  // `document` (not contained by `el`), so it still closes as before.
  const onScroll = (e) => { if (!el.contains(e.target)) close(); };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onGone, true);
  window.addEventListener('scroll', onScroll, true);
  activePopover = { el, onDoc, onKey, onGone, onScroll };
  return { el, close };
}

// Read a single image from the clipboard (used to set a cover image on click).
// Returns a Blob, or null after showing a toast explaining what went wrong.
async function readClipboardImage() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      toast(t('addGame.toast.useShortcut'));
      return null;
    }
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const imgType = it.types.find((ty) => ty.startsWith('image/'));
      if (imgType) return await it.getType(imgType);
    }
    toast(t('addGame.toast.noImage'));
    return null;
  } catch {
    toast(t('addGame.toast.pasteFail'));
    return null;
  }
}

// Copy of an array in random order (Fisher–Yates).
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Inline "<icon> label" markup for buttons/badges/tags; the label is escaped.
const iconText = (icon, text) => `<i class="ti ${icon}" aria-hidden="true"></i> ${esc(text)}`;

// Lazy cover loading (#198). Covers render as CSS background-image, which the
// browser can't natively lazy-load — so a long list (Regal grid, Chronik,
// archive) would fire every cover request on its first paint. Each list render
// creates ONE loader; registered elements get their image only as they
// approach the viewport. The observer is scoped to the render (not shared
// globally) so it is GC'd together with the view's discarded nodes.
// `loadCover(watchEl, url, targetEl)`: observe `watchEl`, set the image on
// `targetEl` (defaults to `watchEl`). Watch the OUTER card when the card uses
// `content-visibility: auto` — skipped content has no layout boxes, so a
// descendant would never report a real intersection.
function createCoverLoader() {
  const apply = (el, url) => { el.style.backgroundImage = `url('${url}')`; };
  if (!('IntersectionObserver' in window))
    return (watchEl, url, targetEl) => apply(targetEl || watchEl, url);
  const pending = new WeakMap();
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const p = pending.get(entry.target);
        if (p) apply(p.target, p.url);
        io.unobserve(entry.target);
      });
    },
    // Start fetching one viewport-height early so scrolling rarely catches an
    // empty frame, while a first paint still skips everything far below.
    { rootMargin: '100% 0px' }
  );
  return (watchEl, url, targetEl) => {
    pending.set(watchEl, { url, target: targetEl || watchEl });
    io.observe(watchEl);
  };
}

// Turn an element into a link to a game's detail page: click or keyboard
// (Enter/Space) opens `showGameDetail(rid, gid)`, with a focusable button
// affordance (the `.game-link` class carries cursor/hover/focus styling).
// Used from the session results and Pokale screens; `showGameDetail` is
// resolved at call time (it lives in a later-loaded script).
//
// `opts.redundant` marks a link that only repeats an adjacent one pointing at
// the same game — a cover thumbnail next to its own title (#145). It stays
// clickable with the mouse but leaves the tab order and the accessibility tree,
// because the alternative is a second, *nameless* "button" on every result row:
// an image element has no text, so it announced as an unlabelled control.
function makeGameLink(el, rid, gid, opts) {
  el.classList.add('game-link');
  if (opts && opts.redundant) {
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('tabindex', '-1');
  } else {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
  }
  el.addEventListener('click', () => showGameDetail(rid, gid));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      showGameDetail(rid, gid);
    }
  });
}

// Turn an element into a link to a member's detail page: click or keyboard
// (Enter/Space) opens `showMember(rid, mid)`, with a focusable button
// affordance (the `.member-link` class carries cursor/hover/focus styling).
// Used from the Start hero row, the Pokale podium and the session results;
// `showMember` is resolved at call time (it lives in a later-loaded script).
function makeMemberLink(el, rid, mid) {
  el.classList.add('member-link');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.addEventListener('click', () => showMember(rid, mid));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      showMember(rid, mid);
    }
  });
}

// GAME_ICON / gameHue / coverPlaceholder live in js/cover.js (loaded earlier),
// which is pure and dependency-free so the test suite can require it.

// Plain localized player-count text ("2–4 Personen"), or '' when the game
// predates the player-count feature (one/both fields missing). The plain form is
// reused wherever a range is shown without the .tag chrome (e.g. the
// link-provider value preview, issue #183).
const playersText = (min, max) => {
  if (!Number.isInteger(min) || !Number.isInteger(max)) return '';
  return min === max
    ? tn(min, 'players.one', 'players.single', { n: min })
    : t('players.range', { min, max });
};

// Games from before the player-count feature could lack the fields -> no tag.
const playersTag = (min, max) => {
  const text = playersText(min, max);
  if (!text) return '';
  return `<span class="tag tag--players"><i class="ti ti-users" aria-hidden="true"></i> ${text}</span>`;
};

