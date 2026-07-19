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

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2200);
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

/* Round cache. Tab switches re-render via showRound and used to re-fetch the
 * full round every time — the dominant felt latency on the hosted deploy.
 * Cache the last-fetched round briefly and serve navigations from it. Safe
 * because (a) api() invalidates on every successful mutation, so a stale hit
 * can only come from *another* device's change, which the short TTL bounds,
 * and (b) views never mutate the round object in place — they re-fetch and
 * re-render after mutations. The mid-session "fresh" fetches in
 * views-session.js intentionally bypass this and call api() directly. */
const ROUND_CACHE_TTL_MS = 30 * 1000;
let roundCache = { rid: null, round: null, at: 0 };
let activityCache = { rid: null, activities: null, at: 0 };
function invalidateRoundCache() {
  roundCache = { rid: null, round: null, at: 0 };
  activityCache = { rid: null, activities: null, at: 0 };
}
async function fetchRound(rid) {
  const fresh = roundCache.rid === rid && Date.now() - roundCache.at < ROUND_CACHE_TTL_MS;
  if (fresh) return roundCache.round;
  const round = await api('GET', '/api/rounds/' + rid);
  roundCache = { rid, round, at: Date.now() };
  return round;
}
// Same pattern for the activity feed, which lives on its own endpoint (#197)
// and so misses the round cache — without this, every Chronik entry re-fetches.
async function fetchActivities(rid) {
  const fresh = activityCache.rid === rid && Date.now() - activityCache.at < ROUND_CACHE_TTL_MS;
  if (fresh) return activityCache.activities;
  const activities = await api('GET', '/api/rounds/' + rid + '/activities');
  activityCache = { rid, activities, at: Date.now() };
  return activities;
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
  document.getElementById('homeBtn').innerHTML =
    `<i class="ti ti-tornado" aria-hidden="true"></i> <span class="topbar__word">${esc(t('app.title'))}</span>`;
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
let regalFilters = { type: 'all', durations: new Set(), tags: new Map(), query: '' };
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
function paintTagChip(chip, name, state) {
  chip.classList.toggle('is-on', state === 'include');
  chip.classList.toggle('is-excluded', state === 'exclude');
  const icon = state === 'exclude' ? 'ti-ban' : 'ti-tags';
  const key =
    state === 'include' ? 'tags.filter.included'
    : state === 'exclude' ? 'tags.filter.excluded'
    : 'tags.filter.ignored';
  chip.setAttribute('aria-label', t(key, { name }));
  chip.innerHTML = `<i class="ti ${icon}" aria-hidden="true"></i>${esc(name)}`;
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

// Apply the round's design: page background + accent color. Everything else —
// placeholders, borders, accent surfaces, the page glow and the finale stage —
// derives from these two custom properties via CSS color-mix (see styles.css).
function applyBackground(bg) {
  const root = document.documentElement.style;
  if (bg && bg.type === 'theme' && bg.page && bg.accent) {
    root.setProperty('--page-bg', bg.page);
    root.setProperty('--brand', bg.accent);
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
function avgColor(avg) {
  const hue = Math.max(0, Math.min(120, ((avg - 1) / 4) * 120));
  return `hsl(${hue}, 60%, 42%)`;
}

// Fixed, friendly palette for member avatars. A member keeps "their" color
// everywhere in the app; assignment is by position in round.members, which is
// append-only, so colors stay stable for the life of the round.
const MEMBER_COLORS = [
  '#d85a30', // coral
  '#1d9e75', // teal
  '#7f77dd', // violet
  '#ba7517', // amber
  '#d4537e', // pink
  '#2f6f9e', // slate blue
  '#639922', // green
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
      const seat = h(`<button type="button" class="nr-seat${joined ? '' : ' nr-seat--out'}" title="${esc(m.name)}">
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
  return bg && bg.type === 'theme' && bg.accent ? bg.accent : STANDARD_ACCENT;
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
  window.removeEventListener('scroll', activePopover.onGone, true);
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
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onGone, true);
  window.addEventListener('scroll', onGone, true);
  activePopover = { el, onDoc, onKey, onGone };
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
function makeGameLink(el, rid, gid) {
  el.classList.add('game-link');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
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

// Tabler icon class for a game type: digital -> gamepad, analog -> dice.
const typeIcon = (type) => (type === 'digital' ? 'ti-device-gamepad-2' : 'ti-dice-3');

const typeTag = (type) =>
  type === 'digital'
    ? `<span class="tag tag--digital"><i class="ti ti-device-gamepad-2" aria-hidden="true"></i> ${t('type.digital')}</span>`
    : `<span class="tag tag--analog"><i class="ti ti-dice-3" aria-hidden="true"></i> ${t('type.analog')}</span>`;

// Games from before the duration feature have duration null -> no tag.
const durationTag = (duration) => {
  if (!['short', 'medium', 'long'].includes(duration)) return '';
  const icon = { short: 'ti-bolt', medium: 'ti-clock', long: 'ti-hourglass' }[duration];
  return `<span class="tag tag--duration"><i class="ti ${icon}" aria-hidden="true"></i> ${t('duration.' + duration)}</span>`;
};

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

// Icon-only badges for the compact card overlay; the full localized word
// stays available as a tooltip.
const typeBadge = (type) =>
  type === 'digital'
    ? `<span class="img-badge" title="${t('type.digital')}"><i class="ti ti-device-gamepad-2" aria-hidden="true"></i></span>`
    : `<span class="img-badge" title="${t('type.analog')}"><i class="ti ti-dice-3" aria-hidden="true"></i></span>`;

const durationBadge = (duration) => {
  if (!['short', 'medium', 'long'].includes(duration)) return '';
  const icon = { short: 'ti-bolt', medium: 'ti-clock', long: 'ti-hourglass' }[duration];
  return `<span class="img-badge" title="${t('duration.' + duration)}"><i class="ti ${icon}" aria-hidden="true"></i></span>`;
};
