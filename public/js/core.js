/* Spieleabend – core: DOM helpers, API, small utilities, stats,
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

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = 'Error';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
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
    `<i class="ti ti-dice-5" aria-hidden="true"></i> ${esc(t('app.title'))}`;
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

// Games list sorting – kept for the running session.
let gamesSort = 'random';
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

// Games from before the player-count feature could lack the fields -> no tag.
const playersTag = (min, max) => {
  if (!Number.isInteger(min) || !Number.isInteger(max)) return '';
  const text = min === max ? t('players.single', { n: min }) : t('players.range', { min, max });
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
