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
  { labelKey: 'theme.sand', page: '#f6efe2', accent: '#a2701d' },
  { labelKey: 'theme.schiefer', page: '#e9eef3', accent: '#33688f' },
  { labelKey: 'theme.pfirsich', page: '#f8ede6', accent: '#c95633' },
];

async function showBackground(rid) {
  currentView = () => showBackground(rid);
  syncUrl(`/round/${rid}/design`);
  app.innerHTML = '<p class="muted">…</p>';
  let round;
  try { round = await fetchRound(rid); }
  catch { return showHome(); }
  applyBackground(round.background);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(rid) },
    { label: t('design.crumb') },
  ]);

  app.innerHTML = '';
  app.appendChild(h(`<div class="page-head"><h1>${esc(t('design.title'))}</h1></div>`));

  const sec = h(`<div class="section"><h3>${esc(t('design.scheme'))}</h3></div>`);
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

  const back = h(`<div class="section center"><button class="btn btn--lg">${esc(t('common.back'))}</button></div>`);
  back.querySelector('button').addEventListener('click', () => navBack(() => showRound(rid)));
  app.appendChild(back);
}

// =================== Tags (custom round tags, #238) ===================

// Manage the round's tag list: create (deduped server-side) and delete (which
// silently unassigns the tag from every game). Assignment to games happens in
// the add-game sheet and the game detail's tag popover, not here.
async function showTags(rid) {
  currentView = () => showTags(rid);
  syncUrl(`/round/${rid}/tags`);
  app.innerHTML = '<p class="muted">…</p>';
  let round;
  try { round = await fetchRound(rid); }
  catch { return showHome(); }
  applyBackground(round.background);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(rid) },
    { label: t('tags.crumb') },
  ]);

  app.innerHTML = '';
  app.appendChild(h(`<div class="page-head"><h1>${esc(t('tags.title'))}</h1></div>`));

  const sec = h('<div class="section"></div>');
  sec.appendChild(h(`<div class="muted" style="margin-bottom:14px">${esc(t('tags.note'))}</div>`));

  const addRow = h(`<div class="toolbar" style="margin-bottom:14px">
       <input class="input" style="flex:1" maxlength="30" placeholder="${esc(t('tags.addPlaceholder'))}" />
       <button class="btn btn--primary"><i class="ti ti-plus" aria-hidden="true"></i> ${esc(t('tags.add'))}</button>
     </div>`);
  const input = addRow.querySelector('input');
  // A duplicate name returns the existing tag (the server dedupes) — detected
  // here by its id already being known, for the right toast.
  const existingIds = new Set((round.tags || []).map((tg) => tg.id));
  const add = async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      const tag = await api('POST', `/api/rounds/${rid}/tags`, { name });
      toast(existingIds.has(tag.id) ? t('tags.toast.exists') : t('tags.toast.added'));
      showTags(rid);
    } catch (e) { toast(e.message === 'quota_tags' ? t('tags.toast.quota') : e.message); }
  };
  addRow.querySelector('button').addEventListener('click', add);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
  });
  sec.appendChild(addRow);

  const tags = round.tags || [];
  if (tags.length === 0) {
    sec.appendChild(h(`<div class="empty"><p>${esc(t('tags.empty'))}</p></div>`));
  } else {
    const list = h('<div class="ds-list"></div>');
    tags.forEach((tg) => {
      const n = round.games.filter((g) => (g.tagIds || []).includes(tg.id)).length;
      const row = h(`<div class="ds-row">
           <div class="ds-row__main"><span class="tag tag--custom">${esc(tg.name)}</span></div>
           <div class="ds-row__meta"><span class="muted">${esc(tn(n, 'tags.gamesOne', 'tags.games'))}</span></div>
         </div>`);
      const del = h(`<button class="btn btn--ghost" aria-label="${esc(t('tags.delete'))}" style="color:var(--danger)"><i class="ti ti-trash" aria-hidden="true"></i></button>`);
      del.addEventListener('click', async () => {
        if (!confirm(t('tags.deleteConfirm', { name: tg.name }))) return;
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

  const back = h(`<div class="section center"><button class="btn btn--lg">${esc(t('common.back'))}</button></div>`);
  back.querySelector('button').addEventListener('click', () => navBack(() => showRound(rid)));
  app.appendChild(back);
}

// =================== Game detail ===================

async function showGameDetail(rid, gameId) {
  currentView = () => showGameDetail(rid, gameId);
  syncUrl(`/round/${rid}/game/${gameId}`);
  app.innerHTML = '<p class="muted">…</p>';
  let round;
  try { round = await fetchRound(rid); }
  catch { return showHome(); }
  applyBackground(round.background);
  const game = round.games.find((g) => g.id === gameId);
  if (!game) return showRound(rid);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(rid) },
    { label: game.title },
  ]);

  const st = gameStats(round, gameId);
  const imgStyle = game.image ? `style="background-image:url('${game.image}')"` : '';
  const fallback = game.image
    ? ''
    : `<i class="ti ${GAME_ICON}" aria-hidden="true"></i>`;
  app.innerHTML = '';

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
          const chip = h(`<button type="button" class="chip${selected.has(tg.id) ? ' is-on' : ''}">${esc(tg.name)}</button>`);
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
      const create = async () => {
        const name = input.value.trim();
        if (!name) return;
        try {
          const tag = await api('POST', `/api/rounds/${rid}/tags`, { name });
          if (!tags.some((x) => x.id === tag.id)) tags.push(tag);
          selected.add(tag.id);
          input.value = '';
          renderChips();
        } catch (e) { toast(e.message === 'quota_tags' ? t('tags.toast.quota') : e.message); }
      };
      addBtn.addEventListener('click', create);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); create(); }
      });
      const okBtn = h(`<button class="btn btn--primary">${esc(t('common.ok'))}</button>`);
      okBtn.addEventListener('click', () => { close(); updateGame({ tagIds: [...selected] }); });
      const row = h('<div class="pp-row"></div>');
      row.appendChild(input);
      row.appendChild(addBtn);
      row.appendChild(okBtn);
      el.appendChild(row);
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

  const head = h(`<div class="gd-head">
       <div class="gd-info">
         <h1></h1>
       </div>
       <div class="gd-stats">${scoreRing}${sortLine}</div>
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

  const hasPl = Number.isInteger(game.minPlayers) && Number.isInteger(game.maxPlayers);
  const plEl = hasPl
    ? h(playersTag(game.minPlayers, game.maxPlayers))
    : h(`<span class="tag tag--players tag--empty">${esc(t('detail.setPlayers'))}</span>`);
  makeEditableTag(plEl, () => openPlayersPopover(plEl));

  h1.append(plEl);

  // Custom round tags (#238): assigned tags render as chips, each opening the
  // edit popover; with none assigned, an empty chip is the way in (and the
  // popover can create the round's very first tag inline).
  const roundTags = round.tags || [];
  const gameTagIds = (game.tagIds || []).filter((x) => roundTags.some((tg) => tg.id === x));
  if (gameTagIds.length) {
    gameTagIds.forEach((x) => {
      const tg = roundTags.find((q) => q.id === x);
      const tagEl = h(`<span class="tag tag--custom">${esc(tg.name)}</span>`);
      makeEditableTag(tagEl, () => openTagsPopover(tagEl));
      h1.append(space(), tagEl);
    });
  } else {
    const tagEl = h(`<span class="tag tag--custom tag--empty">${esc(t('detail.setTags'))}</span>`);
    makeEditableTag(tagEl, () => openTagsPopover(tagEl));
    h1.append(space(), tagEl);
  }
  if (game.retired) h1.append(space(), h(`<span class="tag tag--retired">${iconText('ti-trash', t('result.retiredTag'))}</span>`));

  app.appendChild(head);

  // Retire / restore right from here.
  const actionWrap = h('<div class="toolbar" style="margin-top:18px"></div>');
  if (game.retired) {
    const restore = h(`<button class="btn"><i class="ti ti-arrow-back-up" aria-hidden="true"></i> ${esc(t('detail.restore'))}</button>`);
    restore.addEventListener('click', async () => {
      try {
        await api('POST', `/api/rounds/${rid}/games/${gameId}/retire`, { retired: false });
        toast(t('retired.restored', { title: game.title }));
        showGameDetail(rid, gameId);
      } catch (e) { toast(e.message); }
    });
    actionWrap.appendChild(restore);
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
  }
  app.appendChild(actionWrap);

  // Link back to the provider page when the game was added from an external
  // source. A game with no source instead offers to link one after the fact
  // (issue #74). Provider names are proper nouns, not translated.
  if (game.source && game.source.url) {
    const src = h(`<div class="section"><a class="link-out" href="${esc(game.source.url)}" target="_blank" rel="noopener noreferrer"><i class="ti ti-external-link" aria-hidden="true"></i> ${esc(t('detail.viewSource', { provider: providerLabel(game.source.provider) }))}</a></div>`);
    app.appendChild(src);
  } else if (!game.source) {
    const link = h(`<div class="section"><button class="link-out link-out--btn"><i class="ti ti-link" aria-hidden="true"></i> ${esc(t('detail.linkProvider'))}</button></div>`);
    link.querySelector('button').addEventListener('click', () => showLinkProvider(round, game));
    app.appendChild(link);
  }

  // Related sessions (those that drew this game) – newest first.
  const related = round.sessions
    .filter((s) => s.gameIds.includes(gameId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const sec = h(`<div class="section"><h3>${esc(t('detail.relatedTitle'))}</h3></div>`);
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
      const row = h(`<div class="ds-row${picked ? ' ds-row--picked' : ''}">
           <div class="ds-row__main">
             <div class="ds-row__date">${when}</div>
             <div class="ds-row__status">${status}</div>
           </div>
           <div class="ds-row__meta">${sortCell}${scoreCell}</div>
         </div>`);
      row.addEventListener('click', () => showResults(round, s));
      list.appendChild(row);
    });
    sec.appendChild(list);
  }
  app.appendChild(sec);

  const back = h(`<div class="section center"><button class="btn btn--lg">${esc(t('common.back'))}</button></div>`);
  back.querySelector('button').addEventListener('click', () => navBack(() => showRound(rid, 'regal')));
  app.appendChild(back);
}

// =================== Add game (bottom sheet) ===================

// The active sheet (backdrop element), so navigation/reopen can close it.
let activeSheet = null;
function closeSheet() {
  if (!activeSheet) return;
  document.removeEventListener('keydown', activeSheet.onKey, true);
  activeSheet.el.remove();
  activeSheet = null;
}

