/* Spielwirbel – views: the add-game / link-provider search-as-you-type lookup
   plumbing (provider helpers, attachLookup), the add-game and link-provider
   sheets, and starting a session directly from a game. Loaded after
   views-round.js; shares one global script scope. */

// --- Shared add-game / link-provider lookup plumbing ---
// Provider display names are proper nouns, not translated (see the source link).
const PROVIDER_LABELS = { psstore: 'PlayStation Store', bgg: 'BoardGameGeek', steam: 'Steam', nintendo: 'Nintendo eShop', xbox: 'Xbox' };
function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider;
}
// Brand marks identifying the source of a lookup hit (nominative use). These are
// the official single-color glyphs from Simple Icons (https://simpleicons.org),
// whose SVG path data is released CC0 (public domain); each is rendered in its
// brand's official color. They are a DELIBERATE exception to the theme-derived
// color system (like the fixed category tags and medal colors) — they encode
// brand identity, not theme, so their hardcoded hexes must not be "fixed" to
// accent tones. See .claude/rules/theme-derived-colors.md. Each is a
// self-contained inline SVG (no external/CDN request; the app is local-only).
// `aria-hidden` because the button around it carries the accessible name
// (lookup.fillFrom). Nintendo is represented by the Nintendo Switch mark (Simple
// Icons has no eShop glyph); the accessible name still says "Nintendo eShop".
const PROVIDER_LOGOS = {
  psstore: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="#0070D1"><path d="M8.984 2.596v17.547l3.915 1.261V6.688c0-.69.304-1.151.794-.991.636.18.76.814.76 1.505v5.875c2.441 1.193 4.362-.002 4.362-3.152 0-3.237-1.126-4.675-4.438-5.827-1.307-.448-3.728-1.186-5.39-1.502zm4.656 16.241l6.296-2.275c.715-.258.826-.625.246-.818-.586-.192-1.637-.139-2.357.123l-4.205 1.5V14.98l.24-.085s1.201-.42 2.913-.615c1.696-.18 3.785.03 5.437.661 1.848.601 2.04 1.472 1.576 2.072-.465.6-1.622 1.036-1.622 1.036l-8.544 3.107V18.86zM1.807 18.6c-1.9-.545-2.214-1.668-1.352-2.32.801-.586 2.16-1.052 2.16-1.052l5.615-2.013v2.313L4.205 17c-.705.271-.825.632-.239.826.586.195 1.637.15 2.343-.12L8.247 17v2.074c-.12.03-.256.044-.39.073-1.939.331-3.996.196-6.038-.479z"/></svg>',
  steam: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="#000000"><path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z"/></svg>',
  nintendo: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="#E60012"><path d="M14.176 24h3.674c3.376 0 6.15-2.774 6.15-6.15V6.15C24 2.775 21.226 0 17.85 0H14.1c-.074 0-.15.074-.15.15v23.7c-.001.076.075.15.226.15zm4.574-13.199c1.351 0 2.399 1.125 2.399 2.398 0 1.352-1.125 2.4-2.399 2.4-1.35 0-2.4-1.049-2.4-2.4-.075-1.349 1.05-2.398 2.4-2.398zM11.4 0H6.15C2.775 0 0 2.775 0 6.15v11.7C0 21.226 2.775 24 6.15 24h5.25c.074 0 .15-.074.15-.149V.15c.001-.076-.075-.15-.15-.15zM9.676 22.051H6.15c-2.326 0-4.201-1.875-4.201-4.201V6.15c0-2.326 1.875-4.201 4.201-4.201H9.6l.076 20.102zM3.75 7.199c0 1.275.975 2.25 2.25 2.25s2.25-.975 2.25-2.25c0-1.273-.975-2.25-2.25-2.25s-2.25.977-2.25 2.25z"/></svg>',
  xbox: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="#107C10"><path d="M4.102 21.033C6.211 22.881 8.977 24 12 24c3.026 0 5.789-1.119 7.902-2.967 1.877-1.912-4.316-8.709-7.902-11.417-3.582 2.708-9.779 9.505-7.898 11.417zm11.16-14.406c2.5 2.961 7.484 10.313 6.076 12.912C23.002 17.48 24 14.861 24 12.004c0-3.34-1.365-6.362-3.57-8.536 0 0-.027-.022-.082-.042-.063-.022-.152-.045-.281-.045-.592 0-1.985.434-4.805 3.246zM3.654 3.426c-.057.02-.082.041-.086.042C1.365 5.642 0 8.664 0 12.004c0 2.854.998 5.473 2.661 7.533-1.401-2.605 3.579-9.951 6.08-12.91-2.82-2.813-4.216-3.245-4.806-3.245-.131 0-.223.021-.281.046v-.002zM12 3.551S9.055 1.828 6.755 1.746c-.903-.033-1.454.295-1.521.339C7.379.646 9.659 0 11.984 0H12c2.334 0 4.605.646 6.766 2.085-.068-.046-.615-.372-1.52-.339C14.946 1.828 12 3.545 12 3.545v.006z"/></svg>',
  bgg: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="#FF5100"><path d="m19.7 4.44-2.38.64L19.65 0 4.53 5.56l.83 6.67-1.4 1.34L8.12 24l8.85-3.26 3.07-7.22-1.32-1.27.98-7.81Z"/></svg>',
};
function providerLogo(provider) {
  return PROVIDER_LOGOS[provider] || null;
}

// The lookup queries every provider in parallel and merges the hits into one
// menu, each result carrying its own provider. Providers are rendered
// *progressively* (a fast provider's hits show before a slow one settles) and
// the merged list is ranked by how well each title matches the query, re-sorted
// in place as each provider arrives. One provider failing must not hide the
// others' results — only an all-providers failure shows the error state.
//
// This is the registry order, which doubles as the interleave priority. Since
// #294 it is the FULL set: filter it through enabledProviders() before any
// fan-out, because a round can switch individual providers off.
const LOOKUP_PROVIDERS = ['psstore', 'bgg', 'steam', 'nintendo', 'xbox'];
const MAX_SUGGESTIONS = 10;

// The providers this round queries (#294). An ABSENT `providers` key means the
// round was never configured, which means all of them — so don't treat a missing
// key like an empty list, or every existing round would lose its lookup. An
// empty array is a real, deliberate setting: query nothing.
function enabledProviders(round) {
  const ids = round && round.providers;
  if (!Array.isArray(ids)) return LOOKUP_PROVIDERS;
  return LOOKUP_PROVIDERS.filter((p) => ids.includes(p));
}

async function searchProvider(rid, provider, q) {
  const res = await api('GET', `/api/rounds/${rid}/lookup/search?provider=${provider}&q=${encodeURIComponent(q)}&lang=${encodeURIComponent(getLocale())}`);
  return ((res && res.results) || []).map((r) => Object.assign({ provider }, r));
}

// Fetch one provider's detail for a round, honouring its enabled list server-side.
function lookupDetail(rid, r) {
  return api('GET', `/api/rounds/${rid}/lookup/game?provider=${encodeURIComponent(r.provider)}&id=${encodeURIComponent(r.providerId)}&lang=${encodeURIComponent(getLocale())}`);
}

// Query-match relevance tier (higher = better), case-insensitive on trimmed
// strings. Exact-string tiers only — no fuzzy/edit-distance matching.
function scoreHit(title, q) {
  const s = (title || '').trim().toLowerCase();
  const query = (q || '').trim().toLowerCase();
  if (!s || !query) return 0;
  if (s === query) return 5; // exact title
  if (s.startsWith(query)) return 4; // title starts with the query
  const words = s.split(/\s+/);
  if (words.some((w) => w.startsWith(query))) return 3; // query at a word boundary
  if (s.includes(query)) return 2; // query anywhere as a substring
  const qTokens = query.split(/\s+/).filter(Boolean);
  if (qTokens.length && qTokens.every((qt) => words.some((w) => w.startsWith(qt))))
    return 1; // loose: every query token is a word-prefix in the title
  return 0; // no match
}

// Wire search-as-you-type merged provider suggestions onto an input + menu.
// onPick(result) fires when a suggestion is chosen; onInput() (optional) fires
// on every manual edit. Returns { closeMenu, search }: closeMenu dismisses the
// menu programmatically (e.g. after a pick), search(q) runs a lookup immediately
// (e.g. for a prefilled value on open). Shared by showAddGame and showLinkProvider
// so the two lookups stay in sync.
function attachLookup(round, input, menu, onPick, onInput) {
  const rid = round.id;
  const active = enabledProviders(round);
  // Zero providers enabled is a legitimate configuration (#294): the field stays
  // a plain title input with no dropdown. Return inert stubs so callers can keep
  // calling closeMenu()/search() unconditionally.
  if (!active.length) return { closeMenu() {}, search() {} };

  let searchTimer;
  let searchSeq = 0; // guards against out-of-order responses

  // The menu is `position: fixed` (see styles.css), so it floats free of the
  // sheet's scroll box and can't be clipped by it. That means we place it
  // ourselves against the input's viewport rect: below by default, flipped
  // above when there's more room there, and capped so it never runs off-screen.
  function positionMenu() {
    const r = input.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const gap = 4;
    const edge = 8; // keep a little clearance from the viewport edge
    const spaceBelow = vh - r.bottom - gap - edge;
    const spaceAbove = r.top - gap - edge;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const avail = Math.max(openUp ? spaceAbove : spaceBelow, 120);
    // Grow a bit wider than the input so long titles have room, but stay within
    // the viewport; keep the menu left-anchored to the input, shifting left only
    // if it would overflow the right edge.
    const width = Math.min(Math.max(r.width, 440), vw - 2 * edge);
    const left = Math.max(edge, Math.min(r.left, vw - edge - width));
    menu.style.left = left + 'px';
    menu.style.width = width + 'px';
    menu.style.maxHeight = Math.min(340, avail) + 'px';
    if (openUp) {
      menu.style.top = 'auto';
      menu.style.bottom = (vh - r.top + gap) + 'px';
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = (r.bottom + gap) + 'px';
    }
  }
  // Reposition while open so the menu tracks the input if the sheet scrolls or
  // the window resizes; listeners are bound only while the menu is visible.
  const reposition = () => { if (!menu.hidden) positionMenu(); };
  function openMenu() {
    menu.hidden = false;
    positionMenu();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
  }

  function closeMenu() {
    menu.hidden = true;
    menu.innerHTML = '';
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  }
  function showMenuMsg(msg) {
    menu.innerHTML = `<div class="lookup__msg muted">${esc(msg)}</div>`;
    openMenu();
  }

  function runSearch(q) {
    const seq = ++searchSeq;
    showMenuMsg(t('lookup.searching'));
    const hits = []; // accumulates across providers as each resolves
    let pending = active.length;
    let anyFulfilled = false;

    // Group same-title hits from different providers into one row (ranked by
    // each group's best member), then render one row per group with a badge per
    // contributing provider. Re-run on every arrival so a late provider adds a
    // badge (or a new row) in place — see lookup-group.js.
    function render() {
      if (seq !== searchSeq) return; // a newer keystroke superseded this search
      const groups = groupLookupHits(hits, MAX_SUGGESTIONS);
      if (!groups.length) {
        if (pending > 0) return showMenuMsg(t('lookup.searching'));
        return showMenuMsg(anyFulfilled ? t('lookup.noResults') : t('lookup.error'));
      }
      menu.innerHTML = '';
      groups.forEach((g) => {
        const thumb = g.thumbnail
          ? `<img class="lookup__thumb" src="${esc(g.thumbnail)}" alt="" loading="lazy" />`
          : `<span class="lookup__thumb lookup__thumb--none" aria-hidden="true"><i class="ti ${g.primary.provider === 'bgg' ? 'ti-dice-3' : 'ti-device-gamepad-2'}"></i></span>`;
        const row = h(`<div class="lookup__opt">
            <button type="button" class="lookup__pick">${thumb}<span class="lookup__title">${esc(g.title)}</span></button>
            <span class="lookup__badges"></span>
          </div>`);
        // mousedown (not click) so it fires before the input's blur closes the
        // menu. The title/thumb picks the highest-priority provider…
        row.querySelector('.lookup__pick')
          .addEventListener('mousedown', (e) => { e.preventDefault(); onPick(g.primary); });
        // …and each badge picks that specific provider's hit.
        const badges = row.querySelector('.lookup__badges');
        g.members.forEach((m) => {
          const name = t('lookup.fillFrom', { provider: providerLabel(m.provider) });
          const logo = providerLogo(m.provider);
          // Logo badges for known providers; a text pill still labels any
          // provider without a bundled mark. Either way the button is labelled.
          const badge = logo
            ? h(`<button type="button" class="lookup__badge lookup__badge--logo" title="${esc(name)}" aria-label="${esc(name)}">${logo}</button>`)
            : h(`<button type="button" class="lookup__badge" title="${esc(name)}" aria-label="${esc(name)}">${esc(providerLabel(m.provider))}</button>`);
          badge.addEventListener('mousedown', (e) => { e.preventDefault(); onPick(m); });
          badges.appendChild(badge);
        });
        menu.appendChild(row);
      });
      // A muted, non-clickable hint while a slower provider is still pending.
      if (pending > 0) menu.appendChild(h(`<div class="lookup__msg muted">${esc(t('lookup.loadingMore'))}</div>`));
      openMenu();
    }

    active.forEach((provider, prio) => {
      searchProvider(rid, provider, q).then((list) => {
        if (seq !== searchSeq) return;
        anyFulfilled = true;
        list.forEach((r, order) => hits.push(Object.assign({ score: scoreHit(r.title, q), prio, order }, r)));
      }, () => { /* provider failed — leave its hits out, others still render */ })
        .then(() => { pending--; render(); });
    });
  }

  input.addEventListener('input', () => {
    if (onInput) onInput();
    const q = input.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) return closeMenu();
    searchTimer = setTimeout(() => runSearch(q), 300);
  });
  input.addEventListener('blur', () => setTimeout(closeMenu, 150));

  // Kick off a search immediately (no debounce), respecting the same
  // minimum-length guard as typing. Used to search a prefilled value on open.
  function search(q) {
    clearTimeout(searchTimer);
    q = (q || '').trim();
    if (q.length < 2) return closeMenu();
    runSearch(q);
  }

  return { closeMenu, search };
}

// Opens as a bottom sheet over the current screen (usually the Regal).
function showAddGame(round) {
  closeSheet();
  const backdrop = h(`<div class="sheet-backdrop">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(t('addGame.title'))}">
        <div class="sheet__head">
          <h2>${esc(t('addGame.title'))}</h2>
          <button class="sheet__close" aria-label="${esc(t('common.close'))}"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>
        <div class="field">
          <label for="title">${esc(t('addGame.titleLabel'))}</label>
          <div class="lookup" id="lookup">
            <input id="title" class="input" placeholder="${esc(t('addGame.titlePlaceholder'))}" autocomplete="off" />
            <div class="lookup__menu" id="lookupMenu" hidden></div>
          </div>
          <div class="muted field__hint">${esc(t('addGame.searchHint'))}</div>
        </div>
        <div class="field">
          <label>${esc(t('addGame.playersLabel'))}</label>
          <div class="stepper-row">
            <div class="stepper" data-for="minPlayers">
              <button type="button" class="stepper__btn" data-d="-1" aria-label="−"><i class="ti ti-minus" aria-hidden="true"></i></button>
              <input id="minPlayers" class="stepper__val" inputmode="numeric" value="2" aria-label="${esc(t('addGame.minPlayersPlaceholder'))}" />
              <button type="button" class="stepper__btn" data-d="1" aria-label="+"><i class="ti ti-plus" aria-hidden="true"></i></button>
            </div>
            <span class="muted">–</span>
            <div class="stepper" data-for="maxPlayers">
              <button type="button" class="stepper__btn" data-d="-1" aria-label="−"><i class="ti ti-minus" aria-hidden="true"></i></button>
              <input id="maxPlayers" class="stepper__val" inputmode="numeric" value="4" aria-label="${esc(t('addGame.maxPlayersPlaceholder'))}" />
              <button type="button" class="stepper__btn" data-d="1" aria-label="+"><i class="ti ti-plus" aria-hidden="true"></i></button>
            </div>
            <span class="muted">${esc(t('addGame.playersUnit'))}</span>
          </div>
        </div>
        <div class="field">
          <label>${esc(t('addGame.tagsLabel'))}</label>
          <div class="filter-chips" id="tagSeg" hidden></div>
          <div class="toolbar" style="margin-top:6px">
            <input id="newTag" class="input" placeholder="${esc(t('tags.addPlaceholder'))}" style="flex:1" autocomplete="off" />
            <button type="button" id="addTagBtn" class="btn">${esc(t('tags.add'))}</button>
          </div>
        </div>
        <div class="field">
          <label>${esc(t('addGame.imageLabel'))}</label>
          <div id="pasteZone" class="paste-zone" tabindex="0">
            <div class="paste-zone__hint">
              <div class="paste-zone__icon"><i class="ti ti-photo" aria-hidden="true"></i></div>
              <div>${esc(t('addGame.pasteHint'))}</div>
              <div class="muted" style="font-size:14px">${esc(t('addGame.pasteSub'))}</div>
            </div>
            <img class="paste-zone__preview" hidden />
          </div>
          <div class="toolbar" style="margin-top:10px">
            <button type="button" id="pasteBtn" class="btn"><i class="ti ti-clipboard" aria-hidden="true"></i> ${esc(t('addGame.pasteBtn'))}</button>
            <button type="button" id="clearImg" class="btn btn--ghost" hidden>${esc(t('addGame.removeImage'))}</button>
          </div>
        </div>
        <div class="toolbar sheet__actions">
          <button id="save" class="btn btn--primary btn--lg"><i class="ti ti-plus" aria-hidden="true"></i> ${esc(t('addGame.save'))}</button>
          <button id="saveMore" class="btn btn--lg">${esc(t('addGame.saveMore'))}</button>
        </div>
      </div>
    </div>`);
  const form = backdrop.querySelector('.sheet');
  document.body.appendChild(backdrop);

  // Games added via "Speichern & weiteres" keep the sheet open, so the Regal
  // behind it is only re-rendered when the sheet is finally dismissed. Track
  // whether any game was added while open and refresh on every close path.
  let addedWhileOpen = false;
  const dismiss = () => {
    closeSheet();
    if (addedWhileOpen) showRound(round.id, 'regal');
  };

  const onKey = (e) => {
    if (e.key === 'Escape') dismiss();
  };
  document.addEventListener('keydown', onKey, true);
  activeSheet = { el: backdrop, onKey };
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) dismiss();
  });
  form.querySelector('.sheet__close').addEventListener('click', dismiss);

  // Custom round tags (#238): toggle the round's existing tags onto the new
  // game, or create one inline (added to the round's tag list immediately; a
  // duplicate name reuses the existing tag — the server dedupes).
  const selectedTagIds = new Set();
  const roundTags = (round.tags || []).slice(); // local copy; never mutate the cached round
  const tagSeg = form.querySelector('#tagSeg');
  function renderTagChips() {
    tagSeg.hidden = roundTags.length === 0;
    tagSeg.replaceChildren(...roundTags.map((tg) => {
      const chip = h(`<button type="button" class="chip${selectedTagIds.has(tg.id) ? ' is-on' : ''}"><i class="ti ${tagIconClass(tg.icon)}" aria-hidden="true"></i>${esc(tg.name)}</button>`);
      chip.addEventListener('click', () => {
        if (selectedTagIds.has(tg.id)) selectedTagIds.delete(tg.id);
        else selectedTagIds.add(tg.id);
        chip.classList.toggle('is-on', selectedTagIds.has(tg.id));
      });
      return chip;
    }));
  }
  renderTagChips();
  const newTagInput = form.querySelector('#newTag');
  // Icon picker for the inline "create new tag" (#255). The trigger sits in the
  // new-tag toolbar so the row reads as one sub-form; the grid it expands opens
  // directly below it (#293).
  const tagPicker = tagIconPicker(null);
  newTagInput.after(tagPicker.trigger);
  newTagInput.closest('.toolbar').after(tagPicker.grid);
  const createTag = async () => {
    const name = newTagInput.value.trim();
    if (!name) return;
    try {
      const tag = await api('POST', `/api/rounds/${round.id}/tags`, { name, icon: tagPicker.get() });
      if (!roundTags.some((x) => x.id === tag.id)) roundTags.push(tag);
      selectedTagIds.add(tag.id);
      newTagInput.value = '';
      renderTagChips();
    } catch (e) { toast(e.message === 'quota_tags' ? t('tags.toast.quota') : e.message); }
  };
  form.querySelector('#addTagBtn').addEventListener('click', createTag);
  newTagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createTag(); }
  });

  // Player-count steppers: digits only, +/- clamp at 1.
  const minInput = form.querySelector('#minPlayers');
  const maxInput = form.querySelector('#maxPlayers');
  [minInput, maxInput].forEach((inp) => {
    inp.addEventListener('input', () => {
      const digits = inp.value.replace(/\D/g, '');
      if (inp.value !== digits) inp.value = digits;
    });
  });
  form.querySelectorAll('.stepper').forEach((st) => {
    const input = st.querySelector('.stepper__val');
    st.querySelectorAll('.stepper__btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cur = parseInt(input.value, 10);
        const next = (Number.isInteger(cur) ? cur : 1) + parseInt(btn.dataset.d, 10);
        input.value = Math.max(1, next);
      });
    });
  });

  // --- Image via clipboard ---
  let pastedBlob = null;
  // A store suggestion can supply a cover URL and a source link; a manual paste
  // or a manual title edit clears them (see setImage / the lookup input handler).
  let chosenImageUrl = null;
  let chosenSource = null;
  const pasteZone = form.querySelector('#pasteZone');
  const preview = form.querySelector('.paste-zone__preview');
  const clearBtn = form.querySelector('#clearImg');

  function setImage(blob) {
    if (preview.src && preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
    chosenImageUrl = null; // a pasted/cleared image overrides a provider cover
    pastedBlob = blob;
    if (blob) {
      preview.src = URL.createObjectURL(blob);
      preview.hidden = false;
      pasteZone.classList.add('has-image');
      clearBtn.hidden = false;
    } else {
      preview.removeAttribute('src');
      preview.hidden = true;
      pasteZone.classList.remove('has-image');
      clearBtn.hidden = true;
    }
  }

  // ⌘V anywhere on the page (the listener removes itself when the sheet closes).
  function onPaste(e) {
    if (!document.body.contains(pasteZone)) {
      document.removeEventListener('paste', onPaste);
      return;
    }
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) { setImage(blob); toast(t('addGame.toast.pasted')); e.preventDefault(); }
        return;
      }
    }
  }
  document.addEventListener('paste', onPaste);

  // Button: Clipboard API, reliable on click (also without a keyboard).
  form.querySelector('#pasteBtn').addEventListener('click', async () => {
    const blob = await readClipboardImage();
    if (blob) { setImage(blob); toast(t('addGame.toast.pasted')); }
  });

  clearBtn.addEventListener('click', () => setImage(null));
  pasteZone.addEventListener('click', () => pasteZone.focus());

  // Show a provider cover from its URL (no local blob yet — the server downloads
  // it on save). Cleared like any other image via the remove button.
  function showProviderImage(url) {
    if (preview.src && preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
    pastedBlob = null;
    chosenImageUrl = url;
    preview.src = url;
    preview.hidden = false;
    pasteZone.classList.add('has-image');
    clearBtn.hidden = false;
  }

  // --- Search-as-you-type suggestions (PlayStation Store + BoardGameGeek + Steam) ---
  const titleInput = form.querySelector('#title');
  const menu = form.querySelector('#lookupMenu');
  let lookup; // set below via attachLookup; pickSuggestion uses it to close the menu

  // Fill the player controls from a provider detail object.
  function applyDetail(d) {
    if (Number.isInteger(d.minPlayers)) minInput.value = d.minPlayers;
    if (Number.isInteger(d.maxPlayers)) maxInput.value = d.maxPlayers;
    // A provider with a known min but an unknown (null) max — e.g. Steam for a
    // multiplayer title — would otherwise leave max at the form's default (4),
    // inventing a range the provider never claimed. Cap max at min instead; the
    // user can raise it before saving.
    else if (Number.isInteger(d.minPlayers)) maxInput.value = d.minPlayers;
  }

  async function pickSuggestion(r) {
    lookup.closeMenu();
    titleInput.value = r.title;
    chosenSource = { provider: r.provider, externalId: r.providerId, url: '' };
    // A store cover comes from the search thumbnail; a BGG cover arrives with the
    // detail call.
    if (r.thumbnail && !pastedBlob) showProviderImage(r.thumbnail);
    let d;
    try {
      d = await lookupDetail(round.id, r);
    } catch {
      toast(t('lookup.error'));
      return;
    }
    if (d.title) titleInput.value = d.title;
    chosenSource.url = d.url || '';
    applyDetail(d);
    if (d.imageUrl && !pastedBlob) showProviderImage(d.imageUrl);
    toast(t('addGame.toast.filled', { provider: providerLabel(r.provider) }));
  }

  // A manual edit no longer matches the picked suggestion.
  lookup = attachLookup(round, titleInput, menu, pickSuggestion, () => { chosenSource = null; });

  async function save(again) {
    const title = form.querySelector('#title').value.trim();
    if (!title) return toast(t('addGame.toast.needTitle'));
    const minPlayers = parseInt(minInput.value, 10);
    const maxPlayers = parseInt(maxInput.value, 10);
    if (!Number.isInteger(minPlayers) || minPlayers < 1 || !Number.isInteger(maxPlayers) || maxPlayers < 1)
      return toast(t('addGame.toast.needPlayers'));
    if (maxPlayers < minPlayers) return toast(t('addGame.toast.playersRange'));
    const fd = new FormData();
    fd.append('title', title);
    fd.append('minPlayers', minPlayers);
    fd.append('maxPlayers', maxPlayers);
    selectedTagIds.forEach((x) => fd.append('tagIds', x));
    if (pastedBlob) {
      const ext = (pastedBlob.type && pastedBlob.type.split('/')[1]) || 'png';
      fd.append('image', pastedBlob, 'pasted.' + ext);
    } else if (chosenImageUrl) {
      fd.append('imageUrl', chosenImageUrl);
    }
    if (chosenSource) {
      fd.append('sourceProvider', chosenSource.provider);
      fd.append('sourceExternalId', chosenSource.externalId);
      if (chosenSource.url) fd.append('sourceUrl', chosenSource.url);
    }
    try {
      await api('POST', `/api/rounds/${round.id}/games`, fd);
      toast(t('addGame.toast.saved'));
      if (again) {
        // Keep the sheet open for the next game; the player range stays.
        // Mark dirty so dismissing the sheet re-renders the Regal (issue #34).
        addedWhileOpen = true;
        chosenSource = null;
        lookup.closeMenu();
        form.querySelector('#title').value = '';
        setImage(null);
        form.querySelector('#title').focus();
      } else {
        closeSheet();
        showRound(round.id, 'regal');
      }
    } catch (e) { toast(e.message === 'quota_games' ? t('addGame.toast.quota') : e.message); }
  }
  form.querySelector('#save').addEventListener('click', () => save(false));
  form.querySelector('#saveMore').addEventListener('click', () => save(true));
  form.querySelector('#title').focus();
}

// =================== Link an existing game to a provider (issue #74) ===================

// Sheet for attaching a provider to a game that has no source yet: search the
// providers (prefilled with the game's title), pick a match, then choose which
// differing fields (name, cover, players) to overwrite. The source link is
// always saved; the field overrides default to "take everything".
function showLinkProvider(round, game) {
  closeSheet();
  const backdrop = h(`<div class="sheet-backdrop sheet-backdrop--center">
      <div class="sheet sheet--dialog" role="dialog" aria-modal="true" aria-label="${esc(t('linkProvider.title'))}">
        <div class="sheet__head">
          <h2>${esc(t('linkProvider.title'))}</h2>
          <button class="sheet__close" aria-label="${esc(t('common.close'))}"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>
        <div class="field">
          <label for="linkTitle">${esc(t('linkProvider.searchLabel'))}</label>
          <div class="lookup" id="lookup">
            <input id="linkTitle" class="input" placeholder="${esc(t('addGame.titlePlaceholder'))}" autocomplete="off" />
            <div class="lookup__menu" id="lookupMenu" hidden></div>
          </div>
          <div class="muted field__hint">${esc(t('linkProvider.searchHint'))}</div>
        </div>
        <div id="linkResult"></div>
      </div>
    </div>`);
  const form = backdrop.querySelector('.sheet');
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
  document.addEventListener('keydown', onKey, true);
  activeSheet = { el: backdrop, onKey };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeSheet(); });
  form.querySelector('.sheet__close').addEventListener('click', closeSheet);

  const input = form.querySelector('#linkTitle');
  const menu = form.querySelector('#lookupMenu');
  const resultBox = form.querySelector('#linkResult');
  input.value = game.title;

  // Wire the shared lookup; a manual edit clears the pending match panel.
  const lookup = attachLookup(round, input, menu, pickSuggestion, () => { resultBox.innerHTML = ''; });
  // The title is already filled in, so search for it right away — setting
  // input.value above doesn't fire an 'input' event, so trigger it explicitly.
  lookup.search(game.title);

  async function pickSuggestion(r) {
    lookup.closeMenu();
    input.value = r.title;
    resultBox.innerHTML = `<div class="section muted">${esc(t('lookup.searching'))}</div>`;
    let d;
    try {
      d = await lookupDetail(round.id, r);
    } catch {
      resultBox.innerHTML = '';
      toast(t('lookup.error'));
      return;
    }
    renderMatch(r, d);
  }

  // Show the picked provider match and offer only the fields that actually
  // differ from the current game, each as a toggle chip (on = overwrite).
  function renderMatch(r, d) {
    const fields = [];
    // Cover: offer whenever the provider returns one — a remote URL can't be
    // compared to a local /uploads path, so always treat it as "differs".
    const coverUrl = providerMatchCover(r, d);
    if (coverUrl) fields.push({ key: 'image', label: t('linkProvider.field.image') });
    if ((Number.isInteger(d.minPlayers) && d.minPlayers !== game.minPlayers) ||
        (Number.isInteger(d.maxPlayers) && d.maxPlayers !== game.maxPlayers))
      fields.push({ key: 'players', label: t('linkProvider.field.players') });
    // Name: the add-game flow takes the provider title outright, so offer it
    // here too (issue #180). Show it first — the name is the most prominent
    // field — but only when it actually differs (trimmed, case-insensitive).
    const provTitle = (d.title || r.title || '').trim();
    if (provTitle && provTitle.toLowerCase() !== (game.title || '').trim().toLowerCase())
      fields.unshift({ key: 'title', label: t('linkProvider.field.title') });

    resultBox.innerHTML = '';
    const box = h('<div class="section"></div>');
    box.appendChild(h(`<div class="link-match"><strong>${esc(d.title || r.title)}</strong> · ${esc(providerLabel(r.provider))}</div>`));

    let chips = null;
    if (fields.length) {
      box.appendChild(h(`<div class="muted field__hint" style="margin:10px 0 6px">${esc(t('linkProvider.overridePrompt'))}</div>`));
      // A wrapper holds every toggle (the cover block + the filter-chips row), so
      // isOn(chips, key) keeps finding each chip by [data-field] wherever it sits.
      chips = h('<div class="link-fields"></div>');
      const chipEl = (f) => {
        const chip = h(`<button type="button" class="chip is-on" data-field="${f.key}"><i class="ti ti-check" aria-hidden="true"></i>${esc(f.label)}</button>`);
        chip.addEventListener('click', () => chip.classList.toggle('is-on'));
        return chip;
      };
      // Cover override: pair the "Titelbild" toggle with a preview of the exact
      // image it would apply, so the user isn't opting in blind (issue #179). The
      // remote provider URL renders because CSP img-src lists the provider hosts.
      const imageField = fields.find((f) => f.key === 'image');
      if (imageField) {
        const cover = h('<div class="link-cover"></div>');
        cover.appendChild(h(`<img class="link-cover__img" src="${esc(coverUrl)}" alt="" loading="lazy" />`));
        cover.appendChild(chipEl(imageField));
        chips.appendChild(cover);
      }
      // The players field: pair the toggle with a muted "current value → provider
      // value" line, so — like the cover preview above — the user sees exactly what
      // an on-toggle overwrites (issue #183). The "to" side is what the game
      // *becomes* (applyLink merges), so an absent provider sub-value falls back to
      // the game's own, not a blank.
      const notSet = t('linkProvider.notSet');
      const fieldChange = (key) => {
        if (key === 'players') {
          const toMin = Number.isInteger(d.minPlayers) ? d.minPlayers : game.minPlayers;
          const toMax = Number.isInteger(d.maxPlayers) ? d.maxPlayers : game.maxPlayers;
          return { from: playersText(game.minPlayers, game.maxPlayers) || notSet,
            to: playersText(toMin, toMax) || notSet };
        }
        return null; // title: the provider value is already shown in the header
      };
      const rest = fields.filter((f) => f.key !== 'image');
      if (rest.length) {
        const list = h('<div class="link-field-list"></div>');
        rest.forEach((f) => {
          const field = h('<div class="link-field"></div>');
          field.appendChild(chipEl(f));
          const change = fieldChange(f.key);
          if (change)
            field.appendChild(h(`<div class="link-field__change"><span>${esc(change.from)}</span> <span class="link-field__arrow" aria-hidden="true">→</span> <span class="link-field__to">${esc(change.to)}</span></div>`));
          list.appendChild(field);
        });
        chips.appendChild(list);
      }
      box.appendChild(chips);
    } else {
      box.appendChild(h(`<div class="muted field__hint" style="margin:10px 0">${esc(t('linkProvider.noDiff'))}</div>`));
    }

    const apply = h(`<div class="toolbar sheet__actions"><button class="btn btn--primary btn--lg"><i class="ti ti-link" aria-hidden="true"></i> ${esc(t('linkProvider.apply'))}</button></div>`);
    apply.querySelector('button').addEventListener('click', () => applyLink(r, d, chips));
    box.appendChild(apply);
    resultBox.appendChild(box);
  }

  function isOn(chips, key) {
    if (!chips) return false;
    const chip = chips.querySelector(`[data-field="${key}"]`);
    return !!chip && chip.classList.contains('is-on');
  }

  async function applyLink(r, d, chips) {
    const body = { sourceProvider: r.provider, sourceExternalId: r.providerId };
    if (d.url) body.sourceUrl = d.url;
    if (isOn(chips, 'title')) body.title = (d.title || r.title || '').trim();
    const coverUrl = providerMatchCover(r, d);
    if (isOn(chips, 'image') && coverUrl) body.imageUrl = coverUrl;
    if (isOn(chips, 'players')) {
      if (Number.isInteger(d.minPlayers)) body.minPlayers = d.minPlayers;
      if (Number.isInteger(d.maxPlayers)) body.maxPlayers = d.maxPlayers;
    }
    try {
      await api('PATCH', `/api/rounds/${round.id}/games/${game.id}`, body);
      closeSheet();
      toast(t('linkProvider.linked'));
      showGameDetail(round.id, game.id);
    } catch (e) { toast(e.message); }
  }

  input.focus();
  input.select();
}

// =================== Jetzt spielen (direct-pick session sheet) ===================

// Bottom sheet: pick who joins, then start a session for one specific game with
// no vote and no draw, landing straight on the results screen with that game
// already chosen. Opened from the game detail page and the Pokale cards.
function startDirectSession(round, game) {
  closeSheet();
  const label = t('directPlay.title', { title: game.title });
  const backdrop = h(`<div class="sheet-backdrop">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">
        <div class="sheet__head">
          <h2>${esc(label)}</h2>
          <button class="sheet__close" aria-label="${esc(t('common.close'))}"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>
        <div class="field">
          <label>${esc(t('startSession.membersLabel'))}</label>
          <div id="seatMount"></div>
        </div>
        <div class="toolbar sheet__actions">
          <button id="startDirect" class="btn btn--primary btn--lg"><i class="ti ti-player-play" aria-hidden="true"></i> ${esc(t('directPlay.start'))}</button>
        </div>
      </div>
    </div>`);
  const sheet = backdrop.querySelector('.sheet');
  document.body.appendChild(backdrop);

  const joining = new Set(round.members.map((m) => m.id));
  sheet.querySelector('#seatMount').replaceWith(renderSeatPicker(round, joining));

  const dismiss = () => closeSheet();
  const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
  document.addEventListener('keydown', onKey, true);
  activeSheet = { el: backdrop, onKey };
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) dismiss();
  });
  sheet.querySelector('.sheet__close').addEventListener('click', dismiss);

  sheet.querySelector('#startDirect').addEventListener('click', async () => {
    if (joining.size === 0) return toast(t('startSession.toast.noMembers'));
    try {
      const data = await api('POST', `/api/rounds/${round.id}/sessions`, {
        gameId: game.id,
        memberIds: [...joining],
      });
      closeSheet();
      showResults(round, data.session, data.games);
    } catch (e) { toast(e.message); }
  });
}
