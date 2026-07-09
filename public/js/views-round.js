/* Familien-Spielesammlung – views: round overview, retired games, design,
   game detail, add game. Part of the frontend; all files share one global
   script scope. */

// =================== Round: overview ===================

async function showRound(rid) {
  currentView = () => showRound(rid);
  app.innerHTML = '<p class="muted">…</p>';
  const round = await api('GET', '/api/rounds/' + rid);
  applyBackground(round.background);
  setCrumbs([{ label: t('nav.home'), onClick: showHome }, { label: round.name }]);

  app.innerHTML = '';

  // Active games (in the collection) vs. retired games.
  const activeGames = round.games.filter((g) => !g.retired);
  const retiredGames = round.games.filter((g) => g.retired);

  // Stats per active game, computed once (for recommendation, pill, sorting).
  const statsByGame = {};
  activeGames.forEach((g) => (statsByGame[g.id] = gameStats(round, g.id)));

  // --- Hero band: the round's identity plus the primary "start session" action.
  // This is the launchpad; the start button is the single accent CTA, add-game
  // and design are quieter secondary buttons beside it.
  const playedCount = round.sessions.filter((s) => s.finished).length;
  const initials = (name) => {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    const raw = parts.length >= 2 ? parts[0][0] + parts[1][0] : String(name).trim().slice(0, 2);
    return raw.toUpperCase();
  };
  const hero = h(`<div class="hero">
       <div class="hero__top">
         <div class="hero__id">
           <h1>${esc(round.name)}</h1>
           <div class="hero__members">${round.members
             .map((m) => `<span class="avatar" title="${esc(m.name)}">${esc(initials(m.name))}</span>`)
             .join('')}</div>
           <div class="hero__stats muted">${esc(t('round.statLine', { g: activeGames.length, s: playedCount }))}</div>
         </div>
         <div class="hero__actions"></div>
       </div>
     </div>`);
  const heroActions = hero.querySelector('.hero__actions');

  const addGameBtn = h(`<button class="btn">${esc(t('round.addGame'))}</button>`);
  addGameBtn.addEventListener('click', () => showAddGame(round));
  const bgBtn = h(`<button class="btn">${esc(t('round.design'))}</button>`);
  bgBtn.addEventListener('click', () => showBackground(rid));
  const startBtn = h(`<button class="btn btn--primary btn--lg">${esc(t('round.startSession'))}</button>`);
  startBtn.addEventListener('click', () => showStartSession(round));
  if (activeGames.length === 0) {
    startBtn.disabled = true;
    startBtn.title = t('round.startSessionDisabled');
  }
  heroActions.appendChild(addGameBtn);
  heroActions.appendChild(bgBtn);
  heroActions.appendChild(startBtn);

  // "Last played" highlight: the newest finished session whose chosen game still
  // exists. Delivers the emotional payoff above the fold; tap opens that result.
  const lastPlayed = round.sessions
    .filter((s) => s.finished && s.chosenGameId && round.games.some((g) => g.id === s.chosenGameId))
    .sort((a, b) =>
      String(b.finishedAt || b.chosenAt || b.createdAt).localeCompare(
        String(a.finishedAt || a.chosenAt || a.createdAt)
      )
    )[0];
  if (lastPlayed) {
    const game = round.games.find((g) => g.id === lastPlayed.chosenGameId);
    const winnerNames = (lastPlayed.winnerIds || [])
      .map((wid) => (round.members.find((m) => m.id === wid) || {}).name)
      .filter(Boolean);
    const label = winnerNames.length
      ? t('round.lastPlayedWon', { game: game.title, names: joinNames(winnerNames) })
      : t('round.lastPlayed', { game: game.title });
    const lastEl = h(`<button class="hero__last">${esc(label)}</button>`);
    lastEl.addEventListener('click', () => showResults(round, lastPlayed));
    hero.appendChild(lastEl);
  }
  app.appendChild(hero);

  // Retirement suggestions: a slim, dismissible banner. Enough data = at least
  // three times as many votes as members. Collapsed by default; expand to see
  // the list, or dismiss it for this session.
  const recs = retireRecommendations(activeGames, statsByGame, round.members.length * 3);
  if (recs.length && !minimizedRecs.has(round.id)) {
    const banner = h(`<div class="rec-banner">
         <div class="rec-banner__bar">
           <span class="rec-banner__text">${esc(t('rec.title', { n: recs.length }))}</span>
           <div class="rec-banner__actions">
             <button class="link-btn rec-banner__toggle">${esc(t('rec.show'))}</button>
             <button class="rec-banner__dismiss" title="${esc(t('rec.dismiss'))}" aria-label="${esc(t('rec.dismiss'))}">✕</button>
           </div>
         </div>
         <div class="rec-banner__body" hidden>
           <div class="muted rec-banner__sub">${esc(t('rec.sub'))}</div>
           <div class="recommend-list"></div>
         </div>
       </div>`);
    const body = banner.querySelector('.rec-banner__body');
    const toggle = banner.querySelector('.rec-banner__toggle');
    let expanded = false;
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      body.hidden = !expanded;
      toggle.textContent = expanded ? t('rec.minimize') : t('rec.show');
    });
    banner.querySelector('.rec-banner__dismiss').addEventListener('click', () => {
      minimizedRecs.add(round.id);
      banner.remove();
    });
    const list = banner.querySelector('.recommend-list');
    recs.slice(0, 5).forEach(({ game, reasons }) => {
      const item = h(`<div class="recommend-item">
           <div class="recommend-item__info">
             <span class="recommend-item__title">${esc(game.title)} ${typeTag(game.type)}</span>
             <span class="recommend-item__reason">${reasons.map(esc).join(' · ')}</span>
           </div>
           <button class="btn recommend-item__btn">${esc(t('rec.retire'))}</button>
         </div>`);
      item.querySelector('.recommend-item__title').addEventListener('click', () => showGameDetail(round.id, game.id));
      item.querySelector('.recommend-item__btn').addEventListener('click', async () => {
        if (!confirm(t('detail.retireConfirm', { title: game.title }))) return;
        try {
          await api('POST', `/api/rounds/${round.id}/games/${game.id}/retire`, { retired: true });
          toast(t('games.retired', { title: game.title }));
          showRound(round.id);
        } catch (e) { toast(e.message); }
      });
      list.appendChild(item);
    });
    if (recs.length > 5) {
      list.appendChild(h(`<div class="muted recommend-more">${esc(t('rec.more', { n: recs.length - 5 }))}</div>`));
    }
    app.appendChild(banner);
  }

  // Games
  const gamesSec = h('<div class="section"></div>');
  const gamesHead = h(`<div class="section-head"><h3>${esc(t('games.title', { n: activeGames.length }))}</h3><div class="section-tools"></div></div>`);
  const gamesTools = gamesHead.querySelector('.section-tools');
  gamesSec.appendChild(gamesHead);
  if (activeGames.length === 0) {
    gamesSec.appendChild(h(`<div class="empty"><p>${esc(t('games.empty'))}</p></div>`));
  } else {
    // Average per game (from the already computed stats) for pill and sorting.
    const avgMap = {};
    activeGames.forEach((g) => (avgMap[g.id] = statsByGame[g.id].avg));

    // Search + sort next to the heading. Sort is kept for the session; the
    // search query is local to this view.
    const searchInput = h(`<input class="games-search" type="search" placeholder="${esc(t('games.search'))}" aria-label="${esc(t('games.search'))}" />`);
    const sortSel = h(`<select class="sort-select" aria-label="${esc(t('games.sort.random'))}">
        <option value="random">${esc(t('games.sort.random'))}</option>
        <option value="name">${esc(t('games.sort.name'))}</option>
        <option value="avg">${esc(t('games.sort.rating'))}</option>
      </select>`);
    sortSel.value = gamesSort;
    gamesTools.appendChild(searchInput);
    gamesTools.appendChild(sortSel);

    const grid = h('<div class="cards"></div>');

    // Build the cards once and remember them by game id. When re-sorting we only
    // reorder these existing nodes – no page rebuild that would reset the scroll.
    const cardById = {};
    activeGames.forEach((g) => {
      const imgStyle = g.image ? `style="background-image:url('${g.image}')"` : '';
      const fallback = g.image ? '' : (g.type === 'digital' ? '💻' : '🎲');
      const avg = avgMap[g.id];
      const scorePill =
        avg !== null
          ? `<span class="score-pill" style="background:${avgColor(avg)}">Ø ${avg.toFixed(1)}</span>`
          : `<span class="score-pill score-pill--none">${esc(t('games.scoreNew'))}</span>`;
      const gc = h(`<div class="game-card game-card--clickable">
           <div class="game-card__img" ${imgStyle}>${fallback}
             <div class="game-card__badges">${scorePill}${typeEmoji(g.type)}${durationEmoji(g.duration)}</div>
           </div>
           <div class="game-card__body">
             <div class="game-card__title">${esc(g.title)}</div>
           </div>
         </div>`);
      gc.addEventListener('click', () => showGameDetail(rid, g.id));
      cardById[g.id] = gc;
    });

    // When collapsed we show the first row fully and only the top of the second,
    // increasingly blurred/faded toward the bottom as a hint that there is more.
    // A single control (the pill) toggles expand/collapse in both directions.
    const clip = h('<div class="games-clip"></div>');
    const fade = h('<div class="games-fade"></div>');
    const expandBtn = h('<button class="games-expand"></button>');
    clip.appendChild(grid);
    clip.appendChild(fade);
    clip.appendChild(expandBtn);
    gamesSec.appendChild(clip);
    expandBtn.addEventListener('click', () => { expanded = !expanded; applyCollapse(); });

    let expanded = false;
    let query = '';
    let cards = [];
    function columnsInGrid() {
      if (cards.length === 0) return 1;
      const top = cards[0].offsetTop;
      let cols = 0;
      for (const c of cards) {
        if (c.offsetTop === top) cols++;
        else break;
      }
      return Math.max(1, cols);
    }
    // Full grid, no clip/fade. With a "show less" pill below when the user
    // expanded a long list; hidden when there is nothing to collapse.
    function showFull(withLessBtn) {
      grid.style.maxHeight = '';
      grid.style.overflow = '';
      fade.style.display = 'none';
      if (withLessBtn) {
        expandBtn.style.display = '';
        expandBtn.classList.add('games-expand--less');
        expandBtn.textContent = t('games.showLess');
      } else {
        expandBtn.style.display = 'none';
      }
    }
    function applyCollapse() {
      // While searching, show every match; collapsing would hide results.
      const searching = query.trim() !== '';
      const cols = columnsInGrid();
      const totalRows = Math.ceil(cards.length / cols);
      if (searching || totalRows <= 2) {
        showFull(false);
        return;
      }
      if (expanded) {
        showFull(true);
        return;
      }
      // Collapsed: first row fully + about half the second row visible.
      expandBtn.classList.remove('games-expand--less');
      const cardHeight = cards[0].offsetHeight;
      const rowPitch = cards[cols] ? cards[cols].offsetTop - cards[0].offsetTop : cardHeight;
      const gap = Math.max(0, rowPitch - cardHeight);
      const clipHeight = Math.round(cardHeight + gap + cardHeight * 0.5);
      grid.style.maxHeight = clipHeight + 'px';
      grid.style.overflow = 'hidden';
      fade.style.display = '';
      fade.style.height = Math.round(cardHeight * 0.6) + 'px';
      expandBtn.style.display = '';
      expandBtn.textContent = t('games.showAll', { n: cards.length });
    }

    function orderedGames() {
      if (gamesSort === 'name') {
        return [...activeGames].sort((a, b) =>
          a.title.localeCompare(b.title, getLocale(), { sensitivity: 'base' })
        );
      }
      if (gamesSort === 'avg') {
        // Best first; unrated (null) at the end.
        return [...activeGames].sort((a, b) => (avgMap[b.id] ?? -1) - (avgMap[a.id] ?? -1));
      }
      return randomOrderedGames(round, activeGames);
    }
    function visibleGames() {
      const q = query.trim().toLowerCase();
      const ordered = orderedGames();
      return q ? ordered.filter((g) => g.title.toLowerCase().includes(q)) : ordered;
    }
    // Reorder/filter the existing card nodes (no page rebuild) and re-collapse.
    function renderGames() {
      cards = visibleGames().map((g) => cardById[g.id]);
      if (cards.length === 0) {
        grid.replaceChildren(h(`<div class="muted games-nomatch">${esc(t('games.noMatch', { q: query.trim() }))}</div>`));
        fade.style.display = 'none';
        expandBtn.style.display = 'none';
        return;
      }
      grid.replaceChildren(...cards);
      applyCollapse();
    }

    searchInput.addEventListener('input', () => {
      query = searchInput.value;
      expanded = false;
      renderGames();
    });
    sortSel.addEventListener('change', () => {
      gamesSort = sortSel.value;
      renderGames();
    });
    // First arrangement after layout; re-collapse on resize.
    requestAnimationFrame(renderGames);
    function onResize() {
      if (!document.body.contains(grid)) return window.removeEventListener('resize', onResize);
      if (cards.length) applyCollapse();
    }
    window.addEventListener('resize', onResize);
  }
  app.appendChild(gamesSec);

  // History: past sessions, promoted right below the library and anchored by the
  // chosen game's cover. This is the round's memory — newest first.
  const done = round.sessions.filter((s) => s.done).reverse();
  if (done.length) {
    const sec = h(`<div class="section"><h3>${esc(t('sessions.title'))}</h3></div>`);
    const list = h('<div class="session-list"></div>');
    done.forEach((s) => {
      const when = fmtDateTime(s.createdAt);
      const chosen = s.chosenGameId && round.games.find((g) => g.id === s.chosenGameId);
      const winnerNames = (s.winnerIds || [])
        .map((wid) => (round.members.find((m) => m.id === wid) || {}).name)
        .filter(Boolean);

      // Thumbnail: the chosen game's cover (fallback to its type emoji), or a
      // neutral marker when nothing was chosen / the session was cancelled.
      const thumbStyle = chosen && chosen.image ? `style="background-image:url('${chosen.image}')"` : '';
      const thumbFallback = chosen
        ? chosen.image ? '' : chosen.type === 'digital' ? '💻' : '🎲'
        : s.cancelled ? '✕' : '🗳️';

      // Headline is the chosen game (with a rating pill); the date leads only when
      // no game was played. The meta line carries the rest.
      const title = chosen ? `🎮 ${esc(chosen.title)}` : esc(when);
      let pill = '';
      if (chosen) {
        const sst = gameStatsForSession(round, s, chosen.id);
        if (sst.avg !== null) pill = `<span class="score-pill" style="background:${avgColor(sst.avg)}">Ø ${sst.avg.toFixed(1)}</span>`;
      }

      const parts = [];
      if (chosen) parts.push(esc(when));
      if (s.finished) parts.push(winnerNames.length ? '🏆 ' + winnerNames.map(esc).join(', ') : esc(t('sessions.played')));
      else if (s.cancelled) parts.push(`<span style="color:var(--danger)">${esc(t('sessions.cancelled'))}</span>`);
      parts.push(esc(t('sessions.rated', { n: s.gameIds.length })));

      const card = h(`<button class="session-card">
           <div class="session-card__img" ${thumbStyle}>${thumbFallback}</div>
           <div class="session-card__body">
             <div class="session-card__title">${title}${pill}</div>
             <div class="session-card__meta">${parts.join(' · ')}</div>
           </div>
         </button>`);
      card.addEventListener('click', () => showResults(round, s));
      list.appendChild(card);
    });
    sec.appendChild(list);
    app.appendChild(sec);
  }

  // Activity feed: a quiet, secondary log below the history. A capped scroll
  // region keeps the page short — scroll is expected in a feed, so no
  // height-measuring or collapse machinery is needed.
  const feed = buildActivityFeed(round);
  const feedSec = h('<div class="section"></div>');
  feedSec.appendChild(h(`<div class="section-head"><h3>${esc(t('activity.title'))}</h3></div>`));
  if (feed.length === 0) {
    feedSec.appendChild(h(`<div class="muted">${esc(t('activity.empty'))}</div>`));
  } else {
    const list = h('<div class="activity-feed"></div>');
    feed.forEach((e) => {
      const item = h(`<div class="activity${e.nav ? ' activity--link' : ''}">
           <span class="activity__icon">${e.icon}</span>
           <span class="activity__text">${esc(e.text)}</span>
           <span class="activity__time">${fmtDateTime(e.at)}</span>
           ${e.id ? `<button class="activity__del" title="${esc(t('activity.delete'))}">✕</button>` : ''}
         </div>`);
      if (e.nav) {
        item.addEventListener('click', (ev) => {
          if (ev.target.closest('.activity__del')) return; // delete is not "open"
          e.nav();
        });
      }
      if (e.id) {
        item.querySelector('.activity__del').addEventListener('click', async () => {
          if (!confirm(t('activity.deleteConfirm'))) return;
          try {
            await api('DELETE', `/api/rounds/${rid}/activities/${e.id}`);
            toast(t('activity.deleted'));
            showRound(rid);
          } catch (err) { toast(err.message); }
        });
      }
      list.appendChild(item);
    });
    feedSec.appendChild(list);
  }
  app.appendChild(feedSec);

  // Utility footer: quiet, grouped maintenance actions (view retired games,
  // delete the round) set off from the content above.
  const footer = h('<div class="round-footer"></div>');
  const retiredBtn = h(`<button class="link-btn">${esc(t('retired.link', { n: retiredGames.length }))}</button>`);
  retiredBtn.addEventListener('click', () => showRetired(round.id));
  const delBtn = h(`<button class="link-btn round-footer__danger">${esc(t('round.deleteRound'))}</button>`);
  delBtn.addEventListener('click', async () => {
    if (!confirm(t('round.deleteConfirm', { name: round.name }))) return;
    await api('DELETE', '/api/rounds/' + rid);
    showHome();
  });
  footer.appendChild(retiredBtn);
  footer.appendChild(delBtn);
  app.appendChild(footer);
}

// =================== Retired games ===================

async function showRetired(rid) {
  currentView = () => showRetired(rid);
  app.innerHTML = '<p class="muted">…</p>';
  const round = await api('GET', '/api/rounds/' + rid);
  applyBackground(round.background);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(rid) },
    { label: t('retired.crumb') },
  ]);

  // Newest first.
  const games = round.games
    .filter((g) => g.retired)
    .sort((a, b) => String(b.retiredAt || '').localeCompare(String(a.retiredAt || '')));

  app.innerHTML = '';
  app.appendChild(
    h(`<div class="page-head"><div>
         <h1>${esc(t('retired.title'))}</h1>
         <div class="muted">${esc(round.name)}</div>
       </div></div>`)
  );

  if (games.length === 0) {
    app.appendChild(h(`<div class="empty"><p>${esc(t('retired.empty'))}</p></div>`));
  } else {
    const grid = h('<div class="cards"></div>');
    games.forEach((g) => {
      const imgStyle = g.image ? `style="background-image:url('${g.image}')"` : '';
      const fallback = g.image ? '' : (g.type === 'digital' ? '💻' : '🎲');
      const when = g.retiredAt ? fmtDateTime(g.retiredAt) : '?';
      const gc = h(`<div class="game-card">
           <div class="game-card__img" ${imgStyle}>${fallback}</div>
           <div class="game-card__body">
             <div class="game-card__title">${esc(g.title)}</div>
             <div class="game-card__row">${typeTag(g.type)} ${durationTag(g.duration)}</div>
             <div class="card__meta">${esc(t('retired.at', { when }))}</div>
             <button class="btn" data-act="restore" style="margin-top:10px">${esc(t('retired.restore'))}</button>
             <button class="btn btn--danger" data-act="delete" style="margin-top:8px">${esc(t('retired.delete'))}</button>
           </div>
         </div>`);
      gc.querySelector('[data-act="restore"]').addEventListener('click', async () => {
        try {
          await api('POST', `/api/rounds/${rid}/games/${g.id}/retire`, { retired: false });
          toast(t('retired.restored', { title: g.title }));
          showRetired(rid);
        } catch (e) { toast(e.message); }
      });
      gc.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!confirm(t('retired.deleteConfirm', { title: g.title }))) return;
        try {
          await api('DELETE', `/api/rounds/${rid}/games/${g.id}`);
          toast(t('retired.deleted', { title: g.title }));
          showRetired(rid);
        } catch (e) { toast(e.message); }
      });
      grid.appendChild(gc);
    });
    app.appendChild(grid);
  }

  const back = h(`<div class="section center"><button class="btn btn--lg">${esc(t('common.backToRound'))}</button></div>`);
  back.querySelector('button').addEventListener('click', () => showRound(rid));
  app.appendChild(back);
}

// =================== Design ===================

// Coordinated designs: light background + matching accent color. The first is
// the default (warm cream + orange). Labels are translation keys.
const THEMES = [
  { labelKey: 'theme.standard', page: '#f4f1ea', accent: '#c2410c', pattern: 'clouds', std: true },
  { labelKey: 'theme.blaugrau', page: '#eef3f8', accent: '#2563eb', pattern: 'mist' },
  { labelKey: 'theme.salbei', page: '#e9f1ea', accent: '#2e7d46', pattern: 'grain' },
  { labelKey: 'theme.rose', page: '#f6ecf1', accent: '#bb3a78', pattern: 'marble' },
  { labelKey: 'theme.lavendel', page: '#efedf9', accent: '#6d4ac2', pattern: 'wisps' },
  { labelKey: 'theme.sand', page: '#f6efe2', accent: '#a76a17', pattern: 'clouds' },
  { labelKey: 'theme.schiefer', page: '#e7edf2', accent: '#2f6f9e', pattern: 'wisps' },
  { labelKey: 'theme.pfirsich', page: '#f7ece7', accent: '#d2542f', pattern: 'marble' },
];

async function showBackground(rid) {
  currentView = () => showBackground(rid);
  app.innerHTML = '<p class="muted">…</p>';
  const round = await api('GET', '/api/rounds/' + rid);
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

  const swatches = h('<div class="bg-swatches"></div>');
  THEMES.forEach((th) => {
    const active = th.std ? !currentPage : currentPage === th.page.toLowerCase();
    const sw = h(`<button class="bg-swatch${active ? ' is-active' : ''}" style="background:${th.page}" title="${esc(t(th.labelKey))}">
         <span class="bg-swatch__dot" style="background:${th.accent}"></span>
       </button>`);
    sw.addEventListener('click', async () => {
      const payload = th.std
        ? { type: 'none' }
        : { type: 'theme', page: th.page, accent: th.accent, pattern: th.pattern };
      try {
        const saved = await api('POST', `/api/rounds/${rid}/background`, payload);
        applyBackground(saved.background);
        swatches.querySelectorAll('.bg-swatch').forEach((el) => el.classList.remove('is-active'));
        sw.classList.add('is-active');
        toast(t('design.toast.set'));
      } catch (e) { toast(e.message); }
    });
    swatches.appendChild(sw);
  });
  sec.appendChild(swatches);
  app.appendChild(sec);

  const back = h(`<div class="section center"><button class="btn btn--lg">${esc(t('common.backToRound'))}</button></div>`);
  back.querySelector('button').addEventListener('click', () => showRound(rid));
  app.appendChild(back);
}

// =================== Game detail ===================

async function showGameDetail(rid, gameId) {
  currentView = () => showGameDetail(rid, gameId);
  app.innerHTML = '<p class="muted">…</p>';
  const round = await api('GET', '/api/rounds/' + rid);
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
  const fallback = game.image ? '' : (game.type === 'digital' ? '💻' : '🎲');
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

  // A little menu of mutually exclusive options (type, duration).
  function openMenu(anchor, options, current, onPick) {
    openPopover(anchor, (el, close) => {
      el.classList.add('popover--menu');
      options.forEach((opt) => {
        const btn = h(`<button class="popover__opt${opt.value === current ? ' is-current' : ''}">${opt.label}</button>`);
        btn.addEventListener('click', () => {
          close();
          if (opt.value !== current) onPick(opt.value);
        });
        el.appendChild(btn);
      });
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

  // Header: image + title + average.
  const ratingsLine = t(st.count === 1 ? 'detail.ratingsLineOne' : 'detail.ratingsLine', { n: st.count, s: st.sessions });
  const scoreBig =
    st.avg !== null
      ? `<div class="gd-score" style="color:${avgColor(st.avg)}">${st.avg.toFixed(1)}</div>
         <div class="score-label">${esc(ratingsLine)}</div>`
      : `<div class="gd-score gd-score--none">–</div><div class="score-label">${esc(t('detail.noRating'))}</div>`;
  const sortLine = st.sortCount
    ? `<div class="sort-flag" style="margin-top:8px">${esc(t('detail.totalSort', { n: st.sortCount }))}</div>`
    : '';

  const head = h(`<div class="gd-head">
       <div class="gd-info">
         <h1></h1>
         <div class="gd-stats">${scoreBig}${sortLine}</div>
       </div>
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

  const typeEl = h(typeTag(game.type));
  makeEditableTag(typeEl, () => openMenu(typeEl, [
    { value: 'analog', label: t('type.analog') },
    { value: 'digital', label: t('type.digital') },
  ], game.type, (v) => updateGame({ type: v })));

  const hasDur = ['short', 'medium', 'long'].includes(game.duration);
  const durEl = hasDur
    ? h(durationTag(game.duration))
    : h(`<span class="tag tag--duration tag--empty">${esc(t('detail.setDuration'))}</span>`);
  makeEditableTag(durEl, () => openMenu(durEl, [
    { value: 'short', label: t('duration.short') },
    { value: 'medium', label: t('duration.medium') },
    { value: 'long', label: t('duration.long') },
  ], game.duration, (v) => updateGame({ duration: v })));

  const hasPl = Number.isInteger(game.minPlayers) && Number.isInteger(game.maxPlayers);
  const plEl = hasPl
    ? h(playersTag(game.minPlayers, game.maxPlayers))
    : h(`<span class="tag tag--players tag--empty">${esc(t('detail.setPlayers'))}</span>`);
  makeEditableTag(plEl, () => openPlayersPopover(plEl));

  h1.append(typeEl, space(), durEl, space(), plEl);
  if (game.retired) h1.append(space(), h(`<span class="tag tag--retired">${esc(t('result.retiredTag'))}</span>`));

  app.appendChild(head);

  // Retire / restore right from here.
  const actionWrap = h('<div class="toolbar" style="margin-top:18px"></div>');
  if (game.retired) {
    const restore = h(`<button class="btn">${esc(t('detail.restore'))}</button>`);
    restore.addEventListener('click', async () => {
      try {
        await api('POST', `/api/rounds/${rid}/games/${gameId}/retire`, { retired: false });
        toast(t('retired.restored', { title: game.title }));
        showGameDetail(rid, gameId);
      } catch (e) { toast(e.message); }
    });
    actionWrap.appendChild(restore);
  } else {
    const retire = h(`<button class="btn" style="color:var(--warn)">${esc(t('detail.retire'))}</button>`);
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
          ? `${esc(t('detail.played'))}${names.length ? ' · 🏆 ' + names.map(esc).join(', ') : ''}`
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
      const sortCell = sst.sortCount ? `<span class="sort-flag">🗑️ ${sst.sortCount}×</span>` : '';
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

  const back = h(`<div class="section center"><button class="btn btn--lg">${esc(t('common.backToRound'))}</button></div>`);
  back.querySelector('button').addEventListener('click', () => showRound(rid));
  app.appendChild(back);
}

// =================== Add game ===================

function showAddGame(round) {
  currentView = () => showAddGame(round);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(round.id) },
    { label: t('addGame.crumb') },
  ]);
  app.innerHTML = '';
  app.appendChild(h(`<div class="page-head"><h1>${esc(t('addGame.title'))}</h1></div>`));

  const form = h(`<div>
      <div class="field">
        <label for="title">${esc(t('addGame.titleLabel'))}</label>
        <input id="title" class="input" placeholder="${esc(t('addGame.titlePlaceholder'))}" />
      </div>
      <div class="field">
        <label>${esc(t('addGame.typeLabel'))}</label>
        <div class="segmented" id="typeSeg">
          <label class="is-checked" data-type="analog">${t('type.analog')}</label>
          <label data-type="digital">${t('type.digital')}</label>
        </div>
      </div>
      <div class="field">
        <label>${esc(t('addGame.durationLabel'))}</label>
        <div class="segmented" id="durationSeg">
          <label data-duration="short">${t('duration.short')}</label>
          <label class="is-checked" data-duration="medium">${t('duration.medium')}</label>
          <label data-duration="long">${t('duration.long')}</label>
        </div>
        <div class="muted" style="margin-top:6px;font-size:14px">${esc(t('addGame.durationHint'))}</div>
      </div>
      <div class="field">
        <label>${esc(t('addGame.playersLabel'))}</label>
        <div class="toolbar">
          <input id="minPlayers" class="input" style="width:110px" inputmode="numeric"
                 placeholder="${esc(t('addGame.minPlayersPlaceholder'))}" />
          <span>–</span>
          <input id="maxPlayers" class="input" style="width:110px" inputmode="numeric"
                 placeholder="${esc(t('addGame.maxPlayersPlaceholder'))}" />
        </div>
      </div>
      <div class="field">
        <label>${esc(t('addGame.imageLabel'))}</label>
        <div id="pasteZone" class="paste-zone" tabindex="0">
          <div class="paste-zone__hint">
            <div class="paste-zone__icon">🖼️</div>
            <div>${esc(t('addGame.pasteHint'))}</div>
            <div class="muted" style="font-size:14px">${esc(t('addGame.pasteSub'))}</div>
          </div>
          <img class="paste-zone__preview" hidden />
        </div>
        <div class="toolbar" style="margin-top:10px">
          <button type="button" id="pasteBtn" class="btn">${esc(t('addGame.pasteBtn'))}</button>
          <button type="button" id="clearImg" class="btn btn--ghost" hidden>${esc(t('addGame.removeImage'))}</button>
        </div>
      </div>
      <div class="toolbar">
        <button id="save" class="btn btn--primary btn--lg">${esc(t('addGame.save'))}</button>
        <button id="saveMore" class="btn btn--lg">${esc(t('addGame.saveMore'))}</button>
      </div>
    </div>`);
  app.appendChild(form);

  let type = 'analog';
  const seg = form.querySelector('#typeSeg');
  seg.querySelectorAll('label').forEach((lbl) => {
    lbl.addEventListener('click', () => {
      seg.querySelectorAll('label').forEach((l) => l.classList.remove('is-checked'));
      lbl.classList.add('is-checked');
      type = lbl.dataset.type;
    });
  });

  let duration = 'medium';
  const durSeg = form.querySelector('#durationSeg');
  durSeg.querySelectorAll('label').forEach((lbl) => {
    lbl.addEventListener('click', () => {
      durSeg.querySelectorAll('label').forEach((l) => l.classList.remove('is-checked'));
      lbl.classList.add('is-checked');
      duration = lbl.dataset.duration;
    });
  });

  // Player-count inputs accept digits only (text + filter is stricter than
  // type="number", which still lets "e", "-" etc. through).
  const minInput = form.querySelector('#minPlayers');
  const maxInput = form.querySelector('#maxPlayers');
  [minInput, maxInput].forEach((inp) => {
    inp.addEventListener('input', () => {
      const digits = inp.value.replace(/\D/g, '');
      if (inp.value !== digits) inp.value = digits;
    });
  });

  // --- Image via clipboard ---
  let pastedBlob = null;
  const pasteZone = form.querySelector('#pasteZone');
  const preview = form.querySelector('.paste-zone__preview');
  const clearBtn = form.querySelector('#clearImg');

  function setImage(blob) {
    if (preview.src) URL.revokeObjectURL(preview.src);
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

  // ⌘V anywhere on the page (the listener removes itself when the view changes).
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
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        return toast(t('addGame.toast.useShortcut'));
      }
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const imgType = it.types.find((ty) => ty.startsWith('image/'));
        if (imgType) {
          setImage(await it.getType(imgType));
          toast(t('addGame.toast.pasted'));
          return;
        }
      }
      toast(t('addGame.toast.noImage'));
    } catch {
      toast(t('addGame.toast.pasteFail'));
    }
  });

  clearBtn.addEventListener('click', () => setImage(null));
  pasteZone.addEventListener('click', () => pasteZone.focus());

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
    fd.append('type', type);
    fd.append('duration', duration);
    fd.append('minPlayers', minPlayers);
    fd.append('maxPlayers', maxPlayers);
    if (pastedBlob) {
      const ext = (pastedBlob.type && pastedBlob.type.split('/')[1]) || 'png';
      fd.append('image', pastedBlob, 'pasted.' + ext);
    }
    try {
      await api('POST', `/api/rounds/${round.id}/games`, fd);
      toast(t('addGame.toast.saved'));
      const fresh = await api('GET', '/api/rounds/' + round.id);
      if (again) showAddGame(fresh);
      else showRound(fresh.id);
    } catch (e) { toast(e.message); }
  }
  form.querySelector('#save').addEventListener('click', () => save(false));
  form.querySelector('#saveMore').addEventListener('click', () => save(true));
  form.querySelector('#title').focus();
}
