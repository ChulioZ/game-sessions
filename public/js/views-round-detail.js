/* Spielwirbel – views: a round's game detail screen, the design/background
   picker (THEMES) and the shared sheet open/close helpers. Loaded after
   views-round.js; shares one global script scope. */

// Coordinated designs: light background + matching accent color. The first is
// the default (warm cream + orange). Labels are translation keys. Accents are
// kept soft and slightly muted so they sit well next to the member colors,
// the gold family and the neutral surfaces.
const THEMES = [
  { labelKey: 'theme.standard', page: '#f4f1ea', accent: '#c2410c', std: true },
  { labelKey: 'theme.blaugrau', page: '#eef2f7', accent: '#3a67b1' },
  { labelKey: 'theme.salbei', page: '#eaf1ea', accent: '#397a4b' },
  { labelKey: 'theme.rose', page: '#f6ecf1', accent: '#b23a72' },
  { labelKey: 'theme.lavendel', page: '#efedf8', accent: '#6d55c4' },
  // Sand and Pfirsich were darkened for contrast (#145): the accent is not just
  // a fill, it is also link/breadcrumb TEXT on the page (`--brand`), and at
  // #a2701d / #c95633 those two sat at 3.8:1 — so picking either theme put every
  // link in the app below AA. Both now clear 4.5:1 on their own page and on
  // white. Any new theme has to clear both; test/a11y-contrast.test.js checks it.
  { labelKey: 'theme.sand', page: '#f6efe2', accent: '#91641a' },
  { labelKey: 'theme.schiefer', page: '#e9eef3', accent: '#33688f' },
  { labelKey: 'theme.pfirsich', page: '#f8ede6', accent: '#b34d2e' },
];

async function showBackground(rid) {
  currentView = () => showBackground(rid);
  syncUrl(roundPath(rid, 'design'));
  app.innerHTML = '<p class="muted">…</p>';
  let round;
  try { round = await fetchRound(rid); }
  catch { return showHome(); }
  applyBackground(round.background);
  setContext(round.name);

  app.innerHTML = '';
  renderSubScreenTabs(round, 'design');
  app.appendChild(h(`<div class="page-head"><h1>${esc(t('design.title'))}</h1></div>`));

  const sec = h(`<div class="section"><h2>${esc(t('design.scheme'))}</h2></div>`);
  sec.appendChild(
    h(`<div class="muted" style="margin-bottom:14px">${esc(t('design.note'))}</div>`)
  );

  const bg = round.background;
  const currentPage = bg && bg.type === 'theme' ? (bg.page || '').toLowerCase() : null;

  // Theme cards: each is a tiny live preview of the palette — page background,
  // an accent "button", a text line and the accent dot.
  const swatches = h('<div class="theme-cards"></div>');
  THEMES.forEach((th) => {
    const active = th.std ? !currentPage : currentPage === th.page.toLowerCase();
    const sw = h(`<button class="theme-card${active ? ' is-active' : ''}" style="background:${th.page}" title="${esc(t(th.labelKey))}">
         <span class="theme-card__bar" style="background:${th.accent}"></span>
         <span class="theme-card__line"></span>
         <span class="theme-card__line theme-card__line--short"></span>
         <span class="theme-card__name" style="color:${th.accent}">${esc(t(th.labelKey))}</span>
         <span class="theme-card__check" style="background:${th.accent}"><i class="ti ti-check" aria-hidden="true"></i></span>
       </button>`);
    sw.addEventListener('click', async () => {
      const payload = th.std
        ? { type: 'none' }
        : { type: 'theme', page: th.page, accent: th.accent };
      try {
        const saved = await api('POST', `/api/rounds/${rid}/background`, payload);
        applyBackground(saved.background);
        swatches.querySelectorAll('.theme-card').forEach((el) => el.classList.remove('is-active'));
        sw.classList.add('is-active');
        toast(t('design.toast.set'));
      } catch (e) { toast(e.message); }
    });
    swatches.appendChild(sw);
  });
  sec.appendChild(swatches);
  app.appendChild(sec);

  app.appendChild(backRow(() => showRound(rid)));
}

// =================== Tags (custom round tags, #238) ===================

// Manage the round's tag list: create (deduped server-side) and delete (which
// silently unassigns the tag from every game). Assignment to games happens in
// the add-game sheet and the game detail's tag popover, not here.
async function showTags(rid) {
  currentView = () => showTags(rid);
  syncUrl(roundPath(rid, 'tags'));
  app.innerHTML = '<p class="muted">…</p>';
  let round;
  try { round = await fetchRound(rid); }
  catch { return showHome(); }
  applyBackground(round.background);
  setContext(round.name);

  app.innerHTML = '';
  renderSubScreenTabs(round, 'tags');
  app.appendChild(h(`<div class="page-head"><h1>${esc(t('tags.title'))}</h1></div>`));

  const sec = h('<div class="section"></div>');
  sec.appendChild(h(`<div class="muted" style="margin-bottom:14px">${esc(t('tags.note'))}</div>`));

  const addRow = h(`<div class="toolbar" style="margin-bottom:14px">
       <input class="input" style="flex:1" maxlength="30" placeholder="${esc(t('tags.addPlaceholder'))}"
              aria-label="${esc(t('tags.addPlaceholder'))}" />
       <button class="btn btn--primary"><i class="ti ti-plus" aria-hidden="true"></i> ${esc(t('tags.add'))}</button>
     </div>`);
  const input = addRow.querySelector('input');
  // Icon picker for the new tag (#255). The trigger sits inline in the name row
  // so it reads as one sub-form (#293); the grid it expands still gets the full
  // width on its own line below.
  const picker = tagIconPicker(null);
  input.after(picker.trigger);
  // A duplicate name returns the existing tag (the server dedupes) — detected
  // here by its id already being known, for the right toast.
  const existingIds = new Set((round.tags || []).map((tg) => tg.id));
  const add = async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      const tag = await api('POST', `/api/rounds/${rid}/tags`, { name, icon: picker.get() });
      toast(existingIds.has(tag.id) ? t('tags.toast.exists') : t('tags.toast.added'));
      showTags(rid);
    } catch (e) { toast(e.message === 'quota_tags' ? t('tags.toast.quota') : e.message); }
  };
  // Select the submit button explicitly: the icon-picker trigger (#293) is also
  // a <button> and sits earlier in the row, so a bare `querySelector('button')`
  // would silently bind "add" to the trigger and leave Hinzufügen inert.
  addRow.querySelector('.btn--primary').addEventListener('click', add);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
  });
  sec.appendChild(addRow);
  sec.appendChild(picker.grid);

  const tags = round.tags || [];
  if (tags.length === 0) {
    sec.appendChild(h(`<div class="empty"><p>${esc(t('tags.empty'))}</p></div>`));
  } else {
    const list = h('<div class="ds-list ds-list--tiles"></div>');
    tags.forEach((tg) => {
      const n = round.games.filter((g) => (g.tagIds || []).includes(tg.id)).length;
      const row = h(`<div class="ds-row tag-row">
           <div class="ds-row__main"><span class="tag tag--custom"><i class="ti ${tagIconClass(tg.icon)}" aria-hidden="true"></i>${esc(tg.name)}</span></div>
           <div class="ds-row__meta"><span class="muted tag-row__count">${esc(tn(n, 'tags.gamesOne', 'tags.games'))}</span></div>
         </div>`);
      // Change an existing tag's icon (#255) — the Tags screen is the only
      // surface that edits a tag; the popover and add-game sheet only create
      // and assign. Expands the picker inline rather than opening a dialog.
      const edit = h(`<button class="tag-act" aria-label="${esc(t('tags.editIcon'))}" title="${esc(t('tags.editIcon'))}"><i class="ti ti-pencil" aria-hidden="true"></i></button>`);
      edit.addEventListener('click', () => {
        const open = row.nextElementSibling;
        if (open && open.classList.contains('icon-picker')) { // second click closes it
          open.remove();
          return;
        }
        // Expanded: the pencil button IS the disclosure here (#293), so the
        // picker must not add a second one inside it.
        const p = tagIconPicker(tg.icon, { expanded: true });
        p.grid.querySelectorAll('.icon-picker__btn').forEach((btn) => {
          btn.addEventListener('click', async () => {
            try {
              await api('PATCH', `/api/rounds/${rid}/tags/${tg.id}`, { icon: btn.dataset.icon });
              toast(t('tags.toast.iconUpdated'));
              showTags(rid);
            } catch (e) { toast(e.message); }
          });
        });
        row.after(p.grid);
      });
      row.querySelector('.ds-row__meta').appendChild(edit);
      const del = h(`<button class="tag-act tag-act--danger" aria-label="${esc(t('tags.delete'))}"><i class="ti ti-trash" aria-hidden="true"></i></button>`);
      del.addEventListener('click', async () => {
        if (n > 0 && !confirm(t('tags.deleteConfirm', { name: tg.name }))) return;
        try {
          await api('DELETE', `/api/rounds/${rid}/tags/${tg.id}`);
          toast(t('tags.toast.deleted'));
          showTags(rid);
        } catch (e) { toast(e.message); }
      });
      row.querySelector('.ds-row__meta').appendChild(del);
      list.appendChild(row);
    });
    sec.appendChild(list);
  }
  app.appendChild(sec);

  app.appendChild(backRow(() => showRound(rid)));
}

// =================== Lookup providers (#294) ===================

// Which external game databases this round's add-game / link-provider lookups
// query. Sibling of showTags: both are per-round global configuration.
async function showProviders(rid) {
  currentView = () => showProviders(rid);
  syncUrl(roundPath(rid, 'providers'));
  app.innerHTML = '<p class="muted">…</p>';
  let round;
  try { round = await fetchRound(rid); }
  catch { return showHome(); }
  applyBackground(round.background);
  setContext(round.name);

  app.innerHTML = '';
  renderSubScreenTabs(round, 'providers');
  app.appendChild(h(`<div class="page-head"><h1>${esc(t('providers.title'))}</h1></div>`));

  const sec = h('<div class="section"></div>');
  sec.appendChild(h(`<div class="muted" style="margin-bottom:14px">${esc(t('providers.note'))}</div>`));

  // A round that has never been configured has no `providers` key at all, which
  // means "all of them" — enabledProviders() owns that rule, so read the current
  // state through it rather than re-deriving it here.
  const enabled = new Set(enabledProviders(round));
  const hint = h(`<div class="muted" style="margin-top:14px"></div>`);
  const renderHint = () => {
    hint.textContent = enabled.size ? '' : t('providers.noneHint');
  };

  const list = h('<div class="ds-list ds-list--tiles"></div>');
  LOOKUP_PROVIDERS.forEach((id) => {
    const logo = providerLogo(id);
    const row = h(`<label class="ds-row provider-row">
         <div class="ds-row__main">
           ${logo ? `<span class="provider-row__logo" aria-hidden="true">${logo}</span>` : ''}
           <span>${esc(providerLabel(id))}</span>
         </div>
         <div class="ds-row__meta">
           <input type="checkbox" class="provider-row__box" ${enabled.has(id) ? 'checked' : ''} />
         </div>
       </label>`);
    const box = row.querySelector('input');
    box.addEventListener('change', async () => {
      if (box.checked) enabled.add(id); else enabled.delete(id);
      renderHint();
      try {
        // Always PUT the full list: an empty one is a real setting ("we type our
        // own titles"), not a no-op, so it has to be sent like any other.
        await api('PUT', `/api/rounds/${rid}/providers`, { providers: LOOKUP_PROVIDERS.filter((p) => enabled.has(p)) });
        toast(t('providers.toast.saved'));
      } catch (e) {
        // Put the checkbox back where the server still has it.
        box.checked = !box.checked;
        if (box.checked) enabled.add(id); else enabled.delete(id);
        renderHint();
        toast(e.message);
      }
    });
    list.appendChild(row);
  });
  sec.appendChild(list);
  renderHint();
  sec.appendChild(hint);
  app.appendChild(sec);

  app.appendChild(backRow(() => showRound(rid)));
}

// =================== Game detail ===================

async function showGameDetail(rid, gameId) {
  currentView = () => showGameDetail(rid, gameId);
  syncUrl(gamePath(rid, gameId));
  app.innerHTML = '<p class="muted">…</p>';
  let round;
  try { round = await fetchRound(rid); }
  catch { return showHome(); }
  applyBackground(round.background);
  const game = round.games.find((g) => g.id === gameId);
  if (!game) return showRound(rid);
  setContext(round.name);

  const st = gameStats(round, gameId);
  const imgStyle = game.image ? `style="background-image:url('${coverUrl(game.image, COVER_HERO)}')"` : '';
  const fallback = coverPlaceholder(game);
  app.innerHTML = '';
  renderSubScreenTabs(round, 'game');

  // Send a partial update, then re-render the page from fresh data.
  async function updateGame(updates) {
    const { imageBlob, removeImage, ...fields } = updates;
    let body;
    if (imageBlob || removeImage) {
      // Image involved → multipart. Scalar fields ride along as form fields.
      body = new FormData();
      Object.entries(fields).forEach(([k, v]) => body.append(k, v));
      if (imageBlob) {
        const ext = (imageBlob.type && imageBlob.type.split('/')[1]) || 'png';
        body.append('image', imageBlob, 'cover.' + ext);
      }
      if (removeImage) body.append('removeImage', 'true');
    } else {
      body = fields;
    }
    try {
      await api('PATCH', `/api/rounds/${rid}/games/${gameId}`, body);
      toast(t('detail.saved'));
      showGameDetail(rid, gameId);
    } catch (e) {
      toast(e.message);
    }
  }

  // Turn a tag into a click-to-edit control.
  function makeEditableTag(el, onClick) {
    el.classList.add('tag--edit');
    el.title = t('detail.editHint');
    el.addEventListener('click', onClick);
  }

  // Click the title → inline input; Enter/blur saves, Escape cancels.
  function startTitleEdit(spanEl) {
    const input = h('<input class="input gd-title-input" />');
    input.value = game.title;
    spanEl.replaceWith(input);
    input.focus();
    input.select();
    let handled = false;
    const commit = () => {
      if (handled) return;
      handled = true;
      const val = input.value.trim();
      if (!val || val === game.title) {
        input.replaceWith(spanEl); // nothing changed
        return;
      }
      updateGame({ title: val });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { handled = true; input.replaceWith(spanEl); }
    });
  }

  // Min–max player inputs in a popover.
  function openPlayersPopover(anchor) {
    openPopover(anchor, (el, close) => {
      el.classList.add('popover--players');
      const min = h('<input class="input" inputmode="numeric" />');
      const max = h('<input class="input" inputmode="numeric" />');
      if (Number.isInteger(game.minPlayers)) min.value = game.minPlayers;
      if (Number.isInteger(game.maxPlayers)) max.value = game.maxPlayers;
      [min, max].forEach((inp) => inp.addEventListener('input', () => {
        const digits = inp.value.replace(/\D/g, '');
        if (inp.value !== digits) inp.value = digits;
      }));
      const okBtn = h(`<button class="btn btn--primary">${esc(t('common.ok'))}</button>`);
      const save = () => {
        const mn = parseInt(min.value, 10);
        const mx = parseInt(max.value, 10);
        if (!Number.isInteger(mn) || mn < 1 || !Number.isInteger(mx) || mx < 1)
          return toast(t('addGame.toast.needPlayers'));
        if (mx < mn) return toast(t('addGame.toast.playersRange'));
        close();
        updateGame({ minPlayers: mn, maxPlayers: mx });
      };
      okBtn.addEventListener('click', save);
      [min, max].forEach((inp) => inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
      }));
      const row = h('<div class="pp-row"></div>');
      row.appendChild(min);
      row.appendChild(h('<span>–</span>'));
      row.appendChild(max);
      row.appendChild(okBtn);
      el.appendChild(row);
      min.focus();
      min.select();
    });
  }

  // Edit the game's custom-tag assignment (#238): toggle the round's tags,
  // create a new one inline, then OK applies the whole selection at once (like
  // the players popover — one PATCH, one re-render).
  function openTagsPopover(anchor) {
    openPopover(anchor, (el, close) => {
      el.classList.add('popover--tags');
      const selected = new Set(game.tagIds || []);
      const tags = (round.tags || []).slice(); // local copy; never mutate the cached round
      const chipsWrap = h('<div class="filter-chips"></div>');
      const renderChips = () => {
        chipsWrap.replaceChildren(...tags.map((tg) => {
          const chip = h(`<button type="button" class="chip${selected.has(tg.id) ? ' is-on' : ''}"><i class="ti ${tagIconClass(tg.icon)}" aria-hidden="true"></i>${esc(tg.name)}</button>`);
          chip.addEventListener('click', () => {
            if (selected.has(tg.id)) selected.delete(tg.id);
            else selected.add(tg.id);
            chip.classList.toggle('is-on', selected.has(tg.id));
          });
          return chip;
        }));
        chipsWrap.hidden = tags.length === 0;
      };
      renderChips();
      el.appendChild(chipsWrap);

      const input = h(`<input class="input" maxlength="30" placeholder="${esc(t('tags.addPlaceholder'))}" />`);
      const addBtn = h(`<button class="btn">${esc(t('tags.add'))}</button>`);
      // Icon picker for the inline "create new tag" (#255). The trigger joins
      // the input row and the grid opens below it (#293) — an always-open grid
      // used to push the chips and the input out of this popover entirely.
      const picker = tagIconPicker(null);
      // Returns false only when a real creation attempt failed, so the OK
      // handler below can keep the popover open instead of discarding the
      // typed name (an empty input is a no-op, not a failure).
      const create = async () => {
        const name = input.value.trim();
        if (!name) return true;
        try {
          const tag = await api('POST', `/api/rounds/${rid}/tags`, { name, icon: picker.get() });
          if (!tags.some((x) => x.id === tag.id)) tags.push(tag);
          selected.add(tag.id);
          input.value = '';
          renderChips();
          return true;
        } catch (e) {
          toast(e.message === 'quota_tags' ? t('tags.toast.quota') : e.message);
          return false;
        }
      };
      addBtn.addEventListener('click', create);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); create(); }
      });
      const okBtn = h(`<button class="btn btn--primary">${esc(t('common.ok'))}</button>`);
      // OK commits unsubmitted input first (#249): typing a name and hitting OK
      // without clicking Hinzufügen used to discard it silently.
      okBtn.addEventListener('click', async () => {
        if (!await create()) return; // creation failed — stay open, toast already shown
        close();
        updateGame({ tagIds: [...selected] });
      });
      const row = h('<div class="pp-row"></div>');
      row.appendChild(input);
      row.appendChild(picker.trigger);
      row.appendChild(addBtn);
      row.appendChild(okBtn);
      el.appendChild(row);
      el.appendChild(picker.grid);
      input.focus();
    });
  }

  // Paste a new cover image, or remove the current one.
  function openImagePopover(anchor) {
    openPopover(anchor, (el, close) => {
      el.classList.add('popover--image');
      const paste = h(`<button class="btn btn--primary">${esc(t('detail.pasteImage'))}</button>`);
      paste.addEventListener('click', async () => {
        const blob = await readClipboardImage();
        if (!blob) return; // toast already shown; keep popover open to retry
        close();
        updateGame({ imageBlob: blob });
      });
      el.appendChild(paste);
      if (game.image) {
        const rm = h(`<button class="btn btn--ghost">${esc(t('addGame.removeImage'))}</button>`);
        rm.addEventListener('click', () => { close(); updateGame({ removeImage: true }); });
        el.appendChild(rm);
      }
      el.appendChild(h(`<div class="muted popover__hint">${esc(t('detail.imageHint'))}</div>`));
    });
  }

  // Related sessions (those that drew this game) – newest first. Computed up
  // here, not at its own section below, because `sparse` needs it.
  const related = round.sessions
    .filter((s) => s.gameIds.includes(gameId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  // A game nobody has touched yet: no cover, no rating, no session, no tags
  // (#256). Rendering the normal layout for it produced a page of near-empty
  // widgets — a dash in a grey ring, a dashed chip, one line of muted text —
  // which read as broken rather than new. Instead the page drops the empty
  // widgets entirely and leads with an invitation (see `onboard` below).
  const assignedTagIds = (game.tagIds || []).filter((x) => (round.tags || []).some((tg) => tg.id === x));
  const sparse =
    !game.image && st.avg === null && related.length === 0 && assignedTagIds.length === 0;

  // Header card: image + title + score ring ("Spielepass").
  const ratingsLine = t(st.count === 1 ? 'detail.ratingsLineOne' : 'detail.ratingsLine', { n: st.count, s: st.sessions });
  const RING_C = (2 * Math.PI * 34).toFixed(1);
  const scoreRing =
    st.avg !== null
      ? `<div class="gd-ring">
           <svg viewBox="0 0 80 80" aria-hidden="true">
             <circle cx="40" cy="40" r="34" fill="none" stroke="var(--sunken)" stroke-width="8"/>
             <circle cx="40" cy="40" r="34" fill="none" stroke="${avgColor(st.avg)}" stroke-width="8" stroke-linecap="round"
               stroke-dasharray="${(((st.avg - 1) / 4) * 2 * Math.PI * 34).toFixed(1)} ${RING_C}" transform="rotate(-90 40 40)"/>
           </svg>
           <span class="gd-ring__num" style="color:${avgColor(st.avg)}">${st.avg.toFixed(1)}</span>
         </div>
         <div class="score-label">${esc(ratingsLine)}</div>`
      : `<div class="gd-ring gd-ring--none"><span class="gd-ring__num">–</span></div>
         <div class="score-label">${esc(t('detail.noRating'))}</div>`;
  const sortLine = st.sortCount
    ? `<div class="sort-flag" style="margin-top:8px"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('detail.totalSort', { n: st.sortCount }))}</div>`
    : '';

  // The score ring is dropped for a sparse game — an empty ring next to an
  // empty everything-else is what made the page read as broken (#256).
  const head = h(`<div class="gd-head${sparse ? ' gd-head--sparse' : ''}">
       <div class="gd-info">
         <h1></h1>
       </div>
       ${sparse ? '' : `<div class="gd-stats">${scoreRing}${sortLine}</div>`}
     </div>`);

  // Editable cover image (click to paste a new one or remove it).
  const imgEl = h(`<div class="gd-img gd-img--edit" ${imgStyle} title="${esc(t('detail.changeImage'))}">${fallback}<span class="gd-img__edit">${esc(t('detail.changeImage'))}</span></div>`);
  imgEl.addEventListener('click', () => openImagePopover(imgEl));
  head.prepend(imgEl);

  // Title + editable tags.
  const h1 = head.querySelector('h1');
  const space = () => document.createTextNode(' ');

  const titleEl = h(`<span class="gd-title" title="${esc(t('detail.editName'))}">${esc(game.title)}</span>`);
  titleEl.addEventListener('click', () => startTitleEdit(titleEl));
  h1.append(titleEl, space());

  // On a sparse page the dashed "set …" chips are suppressed: the onboarding
  // panel below already offers those exact actions, and two competing
  // affordances for one action is what made the old layout feel scattered.
  const hasPl = Number.isInteger(game.minPlayers) && Number.isInteger(game.maxPlayers);
  if (hasPl || !sparse) {
    const plEl = hasPl
      ? h(playersTag(game.minPlayers, game.maxPlayers))
      : h(`<span class="tag tag--players tag--empty">${esc(t('detail.setPlayers'))}</span>`);
    makeEditableTag(plEl, () => openPlayersPopover(plEl));
    h1.append(plEl);
  }

  // Custom round tags (#238): assigned tags render as chips, each opening the
  // edit popover; with none assigned, an empty chip is the way in (and the
  // popover can create the round's very first tag inline).
  const roundTags = round.tags || [];
  if (assignedTagIds.length) {
    assignedTagIds.forEach((x) => {
      const tg = roundTags.find((q) => q.id === x);
      const tagEl = h(`<span class="tag tag--custom"><i class="ti ${tagIconClass(tg.icon)}" aria-hidden="true"></i>${esc(tg.name)}</span>`);
      makeEditableTag(tagEl, () => openTagsPopover(tagEl));
      h1.append(space(), tagEl);
    });
  } else if (!sparse) {
    const tagEl = h(`<span class="tag tag--custom tag--empty">${esc(t('detail.setTags'))}</span>`);
    makeEditableTag(tagEl, () => openTagsPopover(tagEl));
    h1.append(space(), tagEl);
  }
  if (game.retired) h1.append(space(), h(`<span class="tag tag--retired">${iconText('ti-trash', t('result.retiredTag'))}</span>`));
  if (game.completed) h1.append(space(), h(`<span class="tag tag--completed">${iconText('ti-circle-check', t('result.completedTag'))}</span>`));

  app.appendChild(head);

  // Archive actions right from here. A game is Active, Retired or Completed
  // (#250), so the three branches are exclusive: an archived game offers only
  // the way back, an active one both ways out.
  const actionWrap = h('<div class="toolbar" style="margin-top:18px"></div>');
  // Restore out of whichever archive the game is in.
  const restoreFrom = (kind, endpoint, body) => {
    const restore = h(`<button class="btn"><i class="ti ti-arrow-back-up" aria-hidden="true"></i> ${esc(t('detail.restore'))}</button>`);
    restore.addEventListener('click', async () => {
      try {
        await api('POST', `/api/rounds/${rid}/games/${gameId}/${endpoint}`, body);
        toast(t(`${kind}.restored`, { title: game.title }));
        showGameDetail(rid, gameId);
      } catch (e) { toast(e.message); }
    });
    actionWrap.appendChild(restore);
  };
  if (game.retired) {
    restoreFrom('retired', 'retire', { retired: false });
  } else if (game.completed) {
    restoreFrom('completed', 'complete', { completed: false });
  } else {
    // Direct launch: skip the vote and play this game right away.
    const play = h(`<button class="btn btn--primary"><i class="ti ti-player-play" aria-hidden="true"></i> ${esc(t('directPlay.button'))}</button>`);
    play.addEventListener('click', () => startDirectSession(round, game));
    actionWrap.appendChild(play);
    const retire = h(`<button class="btn" style="color:var(--warn)"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('detail.retire'))}</button>`);
    retire.addEventListener('click', async () => {
      if (!confirm(t('detail.retireConfirm', { title: game.title }))) return;
      try {
        await api('POST', `/api/rounds/${rid}/games/${gameId}/retire`, { retired: true });
        toast(t('games.retired', { title: game.title }));
        showGameDetail(rid, gameId);
      } catch (e) { toast(e.message); }
    });
    actionWrap.appendChild(retire);
    const complete = h(`<button class="btn" style="color:var(--good)"><i class="ti ti-circle-check" aria-hidden="true"></i> ${esc(t('detail.complete'))}</button>`);
    complete.addEventListener('click', async () => {
      if (!confirm(t('detail.completeConfirm', { title: game.title }))) return;
      try {
        await api('POST', `/api/rounds/${rid}/games/${gameId}/complete`, { completed: true });
        toast(t('games.completed', { title: game.title }));
        showGameDetail(rid, gameId);
      } catch (e) { toast(e.message); }
    });
    actionWrap.appendChild(complete);
  }
  app.appendChild(actionWrap);

  // Sparse game (#256): one inviting panel that says why the page is bare and
  // offers the steps that fill it, instead of scattering half-empty widgets.
  // The actions reuse the very same popovers the chips/cover would have opened,
  // so this is a different presentation of existing affordances, not new API.
  if (sparse) {
    const onboard = h(`<div class="gd-onboard">
         <div class="gd-onboard__head">
           <i class="ti ti-sparkles gd-onboard__icon" aria-hidden="true"></i>
           <div>
             <h2>${esc(t('detail.onboard.title'))}</h2>
             <p class="muted">${esc(t('detail.onboard.text'))}</p>
           </div>
         </div>
         <div class="gd-onboard__acts"></div>
       </div>`);
    const acts = onboard.querySelector('.gd-onboard__acts');
    [
      // The cover popover anchors on the hero itself (that's what it edits);
      // the other two anchor on their own button, which is where the eye is.
      // Cover and tags are always missing here (that's part of `sparse`), but
      // players can already be set — don't offer to fill in what's filled in.
      ['ti-photo', t('detail.onboard.cover'), () => openImagePopover(imgEl)],
      ['ti-tags', t('detail.onboard.tags'), (b) => openTagsPopover(b)],
      ...(hasPl ? [] : [['ti-users', t('detail.onboard.players'), (b) => openPlayersPopover(b)]]),
    ].forEach(([icon, label, onClick]) => {
      const b = h(`<button class="btn gd-onboard__act"><i class="ti ${icon}" aria-hidden="true"></i> ${esc(label)}</button>`);
      b.addEventListener('click', () => onClick(b));
      acts.appendChild(b);
    });
    app.appendChild(onboard);
  }

  // Link back to the provider page when the game was added from an external
  // source. A game with no source instead offers to link one after the fact
  // (issue #74). Provider names are proper nouns, not translated.
  if (game.source) {
    const provider = providerLabel(game.source.provider);
    const src = h('<div class="section gd-source"></div>');
    // A link built before the provider exposed a URL has none — it stays
    // unlinkable rather than rendering nothing at all.
    if (game.source.url) {
      src.appendChild(h(`<a class="link-out" href="${esc(game.source.url)}" target="_blank" rel="noopener noreferrer"><i class="ti ti-external-link" aria-hidden="true"></i> ${esc(t('detail.viewSource', { provider }))}</a>`));
    }
    const un = h(`<button class="link-out link-out--btn link-out--muted"><i class="ti ti-unlink" aria-hidden="true"></i> ${esc(t('detail.unlinkProvider'))}</button>`);
    un.addEventListener('click', async () => {
      // Only a hotlinked provider cover is dropped with the link; the member's
      // own upload is kept, so the two wordings must not be swapped.
      const ownUpload = typeof game.image === 'string' && game.image.startsWith('/uploads/');
      const key = game.image && !ownUpload ? 'detail.unlinkConfirmCover' : 'detail.unlinkConfirm';
      if (!confirm(t(key, { provider }))) return;
      try {
        await api('PATCH', `/api/rounds/${rid}/games/${gameId}`, { removeSource: true });
        toast(t('detail.toast.unlinked'));
        showGameDetail(rid, gameId);
      } catch (e) { toast(e.message); }
    });
    src.appendChild(un);
    app.appendChild(src);
  } else {
    const link = h(`<div class="section"><button class="link-out link-out--btn"><i class="ti ti-link" aria-hidden="true"></i> ${esc(t('detail.linkProvider'))}</button></div>`);
    link.querySelector('button').addEventListener('click', () => showLinkProvider(round, game));
    app.appendChild(link);
  }

  // Related sessions (`related` is computed near the top — `sparse` needs it).
  // On a sparse page the section is omitted entirely: the onboarding panel
  // already explains that ratings and sessions appear once the game is played,
  // so a heading over one line of muted text only adds to the emptiness.
  const sec = h(`<div class="section"><h2>${esc(t('detail.relatedTitle'))}</h2></div>`);
  if (related.length === 0) {
    sec.appendChild(h(`<div class="muted">${esc(t('detail.relatedEmpty'))}</div>`));
  } else {
    const list = h('<div class="ds-list"></div>');
    related.slice(0, 15).forEach((s) => {
      const sst = gameStatsForSession(round, s, gameId);
      const when = fmtDateTime(s.createdAt);
      const picked = s.chosenGameId === gameId;
      let status;
      if (picked) {
        const names = (s.winnerIds || [])
          .map((wid) => (round.members.find((m) => m.id === wid) || {}).name)
          .filter(Boolean);
        status = s.finished
          ? `${esc(t('detail.played'))}${names.length ? ' · <i class="ti ti-trophy" aria-hidden="true"></i> ' + names.map(esc).join(', ') : ''}`
          : esc(t('detail.chosen'));
      } else if (s.cancelled) {
        status = `<span class="muted">${esc(t('detail.sessionCancelled'))}</span>`;
      } else {
        status = `<span class="muted">${esc(t('detail.notChosen'))}</span>`;
      }
      const scoreCell =
        sst.avg !== null
          ? `<span class="score-pill" style="background:${avgColor(sst.avg)}">Ø ${sst.avg.toFixed(1)}</span>`
          : '<span class="score-pill score-pill--none">–</span>';
      const sortCell = sst.sortCount
        ? `<span class="sort-flag"><i class="ti ti-trash" aria-hidden="true"></i> ${sst.sortCount}×</span>`
        : '';
      const row = h(`<a class="ds-row${picked ? ' ds-row--picked' : ''}">
           <div class="ds-row__main">
             <div class="ds-row__date">${when}</div>
             <div class="ds-row__status">${status}</div>
           </div>
           <div class="ds-row__meta">${sortCell}${scoreCell}</div>
         </a>`);
      navLink(row, resultsPath(round.id, s.id), () => showResults(round, s));
      list.appendChild(row);
    });
    sec.appendChild(list);
  }
  if (!sparse) app.appendChild(sec);

  app.appendChild(backRow(() => showRound(rid, 'regal')));
}

// =================== Add game (bottom sheet) ===================

// The active sheet (backdrop element), so navigation/reopen can close it.
let activeSheet = null;

// Sheet history integration (#333). A sheet is not a routable view, but Back
// should dismiss it — as it does on Android and increasingly on the web —
// instead of tearing down the whole screen behind it. So opening a sheet pushes
// ONE URL-less history marker; Back pops it and we close the sheet, swallowing
// the navigation. State-only, not `?sheet=…`: every sheet (add game, link
// provider, move games, feedback, support) holds transient, unsaved input a
// reload would lose anyway, so deep-linking one buys nothing.
//   `sheetHistory`      — a marker is currently on top of the stack.
//   `pendingAfterClose` — a success handler that navigates AFTER the sheet
//     closes ("add game" → Regal) passes its navigation to closeSheet(next); it
//     must run only once the marker has popped, because history.back() fires
//     popstate asynchronously and a synchronous push would interleave with it
//     and corrupt the stack. handleSheetPop() runs it after the pop.
let sheetHistory = false;
let pendingAfterClose = null;

// Register a just-appended sheet as the active one and contain the keyboard in
// it (#145). Every sheet is aria-modal, which only constrains a screen reader —
// without trapFocus, Tab walked out of the dialog into the page behind the
// backdrop. Call this instead of assigning `activeSheet` directly, so no sheet
// can be added later that silently misses the trap OR the Back-dismissal.
function openSheet(backdrop, onKey) {
  // Replacing an already-open sheet (a showX opened while one is up) reuses its
  // marker — tear the old one down here, synchronously, rather than via a
  // leading closeSheet() whose async history.back() would arrive AFTER the new
  // sheet is open and wrongly dismiss it.
  if (activeSheet) teardownSheet();
  const release = trapFocus(backdrop);
  activeSheet = { el: backdrop, onKey, release };
  if (!sheetHistory) {
    history.pushState(Object.assign({}, history.state, { sheet: true }), '');
    sheetHistory = true;
  }
}

// Remove the sheet DOM and release the focus trap. Ordering is load-bearing
// (#145): release AFTER removing the sheet, because the trap restores focus to
// the opener and focusing an element inside a still-attached, about-to-vanish
// dialog would be undone a moment later.
function teardownSheet() {
  if (!activeSheet) return;
  document.removeEventListener('keydown', activeSheet.onKey, true);
  activeSheet.el.remove();
  if (activeSheet.release) activeSheet.release();
  activeSheet = null;
}

// Programmatic close (Escape, backdrop, the × button, a successful submit).
// `next`, if given, is a navigation to run once the pushed marker has been
// consumed — pass it to closeSheet instead of navigating on the next line, so
// the pop and the navigation don't race (see pendingAfterClose above).
function closeSheet(next) {
  if (!activeSheet) { if (typeof next === 'function') next(); return; }
  teardownSheet();
  if (sheetHistory) {
    pendingAfterClose = (typeof next === 'function') ? next : null;
    history.back();            // → popstate → handleSheetPop() consumes the marker, then runs next
  } else if (typeof next === 'function') {
    next();
  }
}

// Called first by router.js's popstate handler (#333). Returns true when this
// pop belongs to the sheet layer, so the router swallows it instead of routing:
//   • a sheet is open  → Back is dismissing it: tear it down, stay on the screen.
//   • the marker is ours → it is being consumed after a programmatic close: run
//     any deferred navigation now that the stack is back on the underlying entry.
function handleSheetPop() {
  if (activeSheet) {
    teardownSheet();
    sheetHistory = false;
    return true;
  }
  if (sheetHistory) {
    sheetHistory = false;
    const next = pendingAfterClose;
    pendingAfterClose = null;
    if (next) next();
    return true;
  }
  return false;
}

