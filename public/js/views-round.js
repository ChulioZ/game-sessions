/* Spieleabend – views: round overview, retired games, design,
   game detail, add game. Part of the frontend; all files share one global
   script scope. */

// =================== Round: hub (Start / Regal / Chronik) ===================

// The round screen is a hub with tabs, switched by the floating dock at the
// bottom.
const HUB_TABS = ['start', 'regal', 'chronik', 'pokale'];

async function showRound(rid, tab) {
  const activeTab = HUB_TABS.includes(tab) ? tab : 'start';
  currentView = () => showRound(rid, activeTab);
  syncUrl(roundPath(rid, activeTab));
  app.innerHTML = '<p class="muted">…</p>';
  // The round may not exist (e.g. a deep link / reload to a deleted round) —
  // fall back to Home instead of hanging on the loading state.
  let round;
  try { round = await api('GET', '/api/rounds/' + rid); }
  catch { return showHome(); }
  applyBackground(round.background);
  setCrumbs([{ label: t('nav.home'), onClick: showHome }, { label: round.name }]);

  app.innerHTML = '';
  const activeGames = round.games.filter((g) => !g.retired);
  if (activeTab === 'regal') renderRegalTab(round, activeGames);
  else if (activeTab === 'chronik') renderChronikTab(round);
  else if (activeTab === 'pokale') renderPokaleTab(round);
  else renderStartTab(round, activeGames);
  renderHubDock(rid, activeTab);
}

// Floating dock: the hub's tab bar.
function renderHubDock(rid, activeTab) {
  const tabs = [
    { id: 'start', icon: 'ti-home', label: t('hub.tab.start') },
    { id: 'regal', icon: 'ti-cards', label: t('hub.tab.regal') },
    { id: 'chronik', icon: 'ti-history', label: t('hub.tab.chronik') },
    { id: 'pokale', icon: 'ti-trophy', label: t('hub.tab.pokale') },
  ];
  const dock = h('<nav class="dock"></nav>');
  tabs.forEach(({ id: tabId, icon, label }) => {
    const item = h(`<button class="dock__item${tabId === activeTab ? ' is-active' : ''}">
         <i class="ti ${icon}" aria-hidden="true"></i>${esc(label)}
       </button>`);
    if (tabId !== activeTab) item.addEventListener('click', () => showRound(rid, tabId));
    dock.appendChild(item);
  });
  app.appendChild(dock);
}

// --- Start tab: the launchpad — identity, the one big CTA, the latest story.
function renderStartTab(round, activeGames) {
  const rid = round.id;

  // Stats per active game (for the retirement recommendations below).
  const statsByGame = {};
  activeGames.forEach((g) => (statsByGame[g.id] = gameStats(round, g.id)));

  const playedCount = round.sessions.filter((s) => s.finished).length;
  const hero = h(`<div class="hero">
       <h1>${esc(round.name)}</h1>
       <div class="hero__members">${round.members
         .map((m) => `<span class="avatar" style="background:${memberColor(round, m.id)}" title="${esc(m.name)}">${esc(initials(m.name))}</span>`)
         .join('')}</div>
       <div class="hero__chips">
         <span class="stat-chip"><i class="ti ti-cards" aria-hidden="true"></i>${esc(tn(activeGames.length, 'home.chip.gamesOne', 'home.chip.games'))}</span>
         <span class="stat-chip"><i class="ti ti-confetti" aria-hidden="true"></i>${esc(tn(playedCount, 'home.chip.sessionsOne', 'home.chip.sessions'))}</span>
       </div>
     </div>`);
  app.appendChild(hero);
  // Each hero avatar opens that member's detail page.
  hero.querySelectorAll('.hero__members .avatar').forEach((el, i) => {
    const m = round.members[i];
    if (m) makeMemberLink(el, rid, m.id);
  });

  const startBtn = h(
    `<button class="btn btn--primary hub-cta"><i class="ti ti-dice-5" aria-hidden="true"></i>${esc(t('round.startSession'))}</button>`
  );
  startBtn.addEventListener('click', () => showStartSession(round));
  if (activeGames.length === 0) {
    startBtn.disabled = true;
    startBtn.title = t('round.startSessionDisabled');
  }
  app.appendChild(startBtn);

  // "In progress" tickets: sessions whose voting is done but that have not yet
  // reached a final state (no winner recorded, not cancelled). Shown above the
  // last-played ticket, newest first; tapping resumes on the results screen.
  round.sessions
    .filter((s) => s.done && !s.finished && !s.cancelled)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .forEach((session) => {
      const game = session.chosenGameId && round.games.find((g) => g.id === session.chosenGameId);
      const when = fmtDateTime(session.chosenAt || session.createdAt);
      const imgStyle = game && game.image ? ` style="background-image:url('${game.image}')"` : '';
      const fallback = game
        ? game.image
          ? ''
          : `<i class="ti ${typeIcon(game.type)}" aria-hidden="true"></i>`
        : '<i class="ti ti-dice-5" aria-hidden="true"></i>';
      let pill = '';
      if (game) {
        const sst = gameStatsForSession(round, session, game.id);
        if (sst.avg !== null) pill = `<span class="score-pill" style="background:${avgColor(sst.avg)}">Ø ${sst.avg.toFixed(1)}</span>`;
      }
      const title = game ? esc(game.title) : esc(t('round.inProgressDeciding'));
      const ticket = h(`<button class="ticket ticket--live">
           <span class="ticket__main">
             <span class="ticket__img"${imgStyle}>${fallback}</span>
             <span class="ticket__info">
               <span class="ticket__label">${esc(t('round.inProgressLabel'))}</span>
               <span class="ticket__title">${title}</span>
               <span class="ticket__meta">${esc(when)}${pill}</span>
             </span>
           </span>
           <span class="ticket__stub">
             <i class="ti ti-player-play" aria-hidden="true"></i>
             <span class="ticket__names">${esc(t('round.resume'))}</span>
           </span>
         </button>`);
      ticket.addEventListener('click', () => showResults(round, session));
      app.appendChild(ticket);
    });

  // "Last played" ticket: the newest finished session whose chosen game still
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
    const sst = gameStatsForSession(round, lastPlayed, game.id);
    const when = fmtDateTime(lastPlayed.finishedAt || lastPlayed.chosenAt || lastPlayed.createdAt);
    const imgStyle = game.image ? ` style="background-image:url('${game.image}')"` : '';
    const fallback = game.image
      ? ''
      : `<i class="ti ${typeIcon(game.type)}" aria-hidden="true"></i>`;
    const pill =
      sst.avg !== null
        ? `<span class="score-pill" style="background:${avgColor(sst.avg)}">Ø ${sst.avg.toFixed(1)}</span>`
        : '';
    const ticket = h(`<button class="ticket">
         <span class="ticket__main">
           <span class="ticket__img"${imgStyle}>${fallback}</span>
           <span class="ticket__info">
             <span class="ticket__label">${esc(t('round.lastPlayedLabel'))}</span>
             <span class="ticket__title">${esc(game.title)}</span>
             <span class="ticket__meta">${esc(when)}${pill}</span>
           </span>
         </span>
         <span class="ticket__stub">
           <i class="ti ti-trophy" aria-hidden="true"></i>
           <span class="ticket__names">${winnerNames.length ? esc(joinNames(winnerNames)) : esc(t('sessions.played'))}</span>
         </span>
       </button>`);
    ticket.addEventListener('click', () => showResults(round, lastPlayed));
    app.appendChild(ticket);
  }

  // Retirement suggestions: a slim, dismissible banner. Enough data = at least
  // three times as many votes as members. Collapsed by default; expand to see
  // the list, or dismiss it for this session.
  const recs = retireRecommendations(activeGames, statsByGame, round.members.length * 3);
  if (recs.length && !minimizedRecs.has(round.id)) {
    const banner = h(`<div class="rec-banner">
         <div class="rec-banner__bar" role="button" tabindex="0" aria-expanded="false">
           <span class="rec-banner__text"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('rec.title', { n: recs.length }))}</span>
           <div class="rec-banner__actions">
             <i class="ti ti-chevron-down rec-banner__caret" aria-hidden="true"></i>
             <button class="rec-banner__dismiss" title="${esc(t('rec.dismiss'))}" aria-label="${esc(t('rec.dismiss'))}"><i class="ti ti-x" aria-hidden="true"></i></button>
           </div>
         </div>
         <div class="rec-banner__body" hidden>
           <div class="muted rec-banner__sub">${esc(t('rec.sub'))}</div>
           <div class="recommend-list"></div>
         </div>
       </div>`);
    const body = banner.querySelector('.rec-banner__body');
    const bar = banner.querySelector('.rec-banner__bar');
    let expanded = false;
    const toggle = () => {
      expanded = !expanded;
      body.hidden = !expanded;
      banner.classList.toggle('is-open', expanded);
      bar.setAttribute('aria-expanded', String(expanded));
    };
    bar.addEventListener('click', toggle);
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    banner.querySelector('.rec-banner__dismiss').addEventListener('click', (e) => {
      e.stopPropagation();
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

  // Buy-next / play-next suggestions (issue #101): a local rediscovery list
  // (Layer A) plus an opt-in LLM buy-next list (Layer B).
  renderBuyNext(round, activeGames, statsByGame);

  // Quick actions: quieter secondary tasks below the fold.
  const actions = h('<div class="hub-actions"></div>');
  const addGameBtn = h(
    `<button class="btn"><i class="ti ti-plus" aria-hidden="true"></i> ${esc(t('round.addGame'))}</button>`
  );
  addGameBtn.addEventListener('click', () => showAddGame(round));
  const bgBtn = h(
    `<button class="btn"><i class="ti ti-palette" aria-hidden="true"></i> ${esc(t('round.design'))}</button>`
  );
  bgBtn.addEventListener('click', () => showBackground(rid));
  actions.appendChild(addGameBtn);
  actions.appendChild(bgBtn);
  app.appendChild(actions);
}

// --- Buy-next / play-next suggestions (issue #101).
// Layer A: a local, always-on "play these again" list (highly-rated but
// rarely-played owned games), gated on enough votes. Layer B: an opt-in button
// that asks the backend LLM route for real buy-next titles, cached per round.
function renderBuyNext(round, activeGames, statsByGame) {
  const cached = round.recommendations && Array.isArray(round.recommendations.items)
    ? round.recommendations
    : null;
  // Nothing to offer on a near-empty round (unless a list was already generated).
  if (activeGames.length < 3 && !cached) return;

  const section = h(`<section class="buynext">
       <h2 class="buynext__head"><i class="ti ti-bulb" aria-hidden="true"></i> ${esc(t('buynext.title'))}</h2>
     </section>`);

  // Layer A — local rediscovery. Enough data = three times as many votes as
  // members (same gate as the retirement banner).
  const playNext = playNextRecommendations(activeGames, statsByGame, round.members.length * 3);
  if (playNext.length) {
    const block = h(`<div class="buynext__block">
         <div class="buynext__label">${esc(t('buynext.playTitle'))}</div>
         <div class="muted buynext__sub">${esc(t('buynext.playSub'))}</div>
         <div class="recommend-list"></div>
       </div>`);
    const list = block.querySelector('.recommend-list');
    playNext.slice(0, 5).forEach(({ game, avg }) => {
      const item = h(`<div class="recommend-item">
           <div class="recommend-item__info">
             <span class="recommend-item__title">${esc(game.title)} ${typeTag(game.type)}</span>
           </div>
           <span class="score-pill" style="background:${avgColor(avg)}">Ø ${avg.toFixed(1)}</span>
         </div>`);
      item.querySelector('.recommend-item__title').addEventListener('click', () => showGameDetail(round.id, game.id));
      list.appendChild(item);
    });
    section.appendChild(block);
  }

  // Layer B — opt-in LLM buy-next list. Titles here aren't owned games, so the
  // --static variant drops the clickable-title affordance Layer A uses.
  const llm = h(`<div class="buynext__block buynext__block--static"></div>`);
  if (cached) {
    llm.appendChild(h(`<div class="buynext__label">${esc(t('buynext.llmTitle'))}</div>`));
    const list = h('<div class="recommend-list"></div>');
    cached.items.slice(0, 8).forEach(({ title, reason }) => {
      list.appendChild(h(`<div class="recommend-item">
           <div class="recommend-item__info">
             <span class="recommend-item__title">${esc(title)}</span>
             ${reason ? `<span class="recommend-item__reason">${esc(reason)}</span>` : ''}
           </div>
         </div>`));
    });
    llm.appendChild(list);
    llm.appendChild(h(`<div class="muted buynext__meta">${esc(t('buynext.meta', {
      when: fmtDateTime(cached.generatedAt),
      model: cached.model || '',
    }))}</div>`));
    const regen = h(`<button class="btn buynext__gen"><i class="ti ti-refresh" aria-hidden="true"></i> ${esc(t('buynext.regenerate'))}</button>`);
    regen.addEventListener('click', () => generateBuyNext(round, regen));
    llm.appendChild(regen);
  } else {
    llm.appendChild(h(`<div class="buynext__label">${esc(t('buynext.llmTitle'))}</div>`));
    llm.appendChild(h(`<div class="muted buynext__sub">${esc(t('buynext.llmIntro'))}</div>`));
    const gen = h(`<button class="btn btn--primary buynext__gen"><i class="ti ti-sparkles" aria-hidden="true"></i> ${esc(t('buynext.generate'))}</button>`);
    gen.addEventListener('click', () => generateBuyNext(round, gen));
    llm.appendChild(gen);
    llm.appendChild(h(`<div class="muted buynext__note"><i class="ti ti-cloud-up" aria-hidden="true"></i> ${esc(t('buynext.llmNote'))}</div>`));
  }
  section.appendChild(llm);

  app.appendChild(section);
}

// POST the round's taste profile to the LLM route and re-render on success. On
// failure the app is untouched — Layer A stays as the fallback.
async function generateBuyNext(round, btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i class="ti ti-loader-2 spin" aria-hidden="true"></i> ${esc(t('buynext.generating'))}`;
  try {
    const rec = await api('POST', `/api/rounds/${round.id}/recommendations`);
    round.recommendations = rec;
    showRound(round.id); // re-render the Start tab with the cached list
  } catch (e) {
    toast(e.message === 'not_configured' ? t('buynext.unavailable') : t('buynext.failed'));
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// --- Regal tab: the games library — search, filter chips, cover grid.
function renderRegalTab(round, activeGames) {
  const rid = round.id;

  // Filters (and sort) persist for the session but are scoped to one round —
  // opening a different round's Regal resets them to defaults.
  if (regalFiltersRid !== round.id) {
    regalFilters = { type: 'all', durations: new Set(), query: '' };
    gamesSort = 'avg';
    regalFiltersRid = round.id;
  }

  // Stats per active game (for the rating pills and sorting).
  const statsByGame = {};
  activeGames.forEach((g) => (statsByGame[g.id] = gameStats(round, g.id)));

  const gamesSec = h('<div class="section"></div>');
  const gamesHead = h(`<div class="section-head"><h3>${esc(t('games.title', { n: activeGames.length }))}</h3><div class="section-tools"></div></div>`);
  const gamesTools = gamesHead.querySelector('.section-tools');
  gamesSec.appendChild(gamesHead);

  const grid = h('<div class="cards"></div>');

  // The dashed "add a game" tile always closes the grid.
  const addTile = h(`<button class="add-tile">
       <i class="ti ti-plus" aria-hidden="true"></i>
       <span>${esc(t('round.addGame'))}</span>
     </button>`);
  addTile.addEventListener('click', () => showAddGame(round));

  if (activeGames.length === 0) {
    gamesSec.appendChild(h(`<div class="empty"><p>${esc(t('games.empty'))}</p></div>`));
    grid.appendChild(addTile);
    gamesSec.appendChild(grid);
  } else {
    // Average per game (from the already computed stats) for pill and sorting.
    const avgMap = {};
    activeGames.forEach((g) => (avgMap[g.id] = statsByGame[g.id].avg));

    // Search pill + sort next to the heading. Sort, search and filter chips are
    // all kept for the session (scoped to this round) — see regalFilters.
    const search = h(`<label class="search-pill"><i class="ti ti-search" aria-hidden="true"></i><input type="search" placeholder="${esc(t('games.search'))}" aria-label="${esc(t('games.search'))}" /></label>`);
    const searchInput = search.querySelector('input');
    searchInput.value = regalFilters.query;
    const sortSel = h(`<select class="sort-select" aria-label="${esc(t('games.sortLabel'))}">
        <option value="random">${esc(t('games.sort.random'))}</option>
        <option value="name">${esc(t('games.sort.name'))}</option>
        <option value="avg">${esc(t('games.sort.rating'))}</option>
      </select>`);
    sortSel.value = gamesSort;
    gamesTools.appendChild(search);
    gamesTools.appendChild(sortSel);

    // Filter chips: type behaves like a radio group, durations toggle freely
    // (none selected = duration doesn't matter).
    const counts = {
      analog: activeGames.filter((g) => g.type === 'analog').length,
      digital: activeGames.filter((g) => g.type === 'digital').length,
    };
    // Initialize from the persisted state; durFilter is the same Set instance,
    // so toggling it writes straight back into regalFilters.
    let typeFilter = regalFilters.type;
    const durFilter = regalFilters.durations;
    let query = regalFilters.query;
    const chips = h(`<div class="filter-chips">
        <button class="chip" data-type="all">${esc(t('games.filter.all', { n: activeGames.length }))}</button>
        <button class="chip" data-type="analog"><i class="ti ti-dice-3" aria-hidden="true"></i>${esc(t('games.filter.analog', { n: counts.analog }))}</button>
        <button class="chip" data-type="digital"><i class="ti ti-device-gamepad-2" aria-hidden="true"></i>${esc(t('games.filter.digital', { n: counts.digital }))}</button>
        <span class="filter-chips__sep"></span>
        <button class="chip" data-dur="short"><i class="ti ti-bolt" aria-hidden="true"></i>${esc(t('duration.short'))}</button>
        <button class="chip" data-dur="medium"><i class="ti ti-clock" aria-hidden="true"></i>${esc(t('duration.medium'))}</button>
        <button class="chip" data-dur="long"><i class="ti ti-hourglass" aria-hidden="true"></i>${esc(t('duration.long'))}</button>
      </div>`);
    // Reflect the persisted filters on the freshly built chips.
    chips.querySelectorAll('[data-type]').forEach((c) => c.classList.toggle('is-on', c.dataset.type === typeFilter));
    chips.querySelectorAll('[data-dur]').forEach((c) => c.classList.toggle('is-on', durFilter.has(c.dataset.dur)));
    chips.querySelectorAll('[data-type]').forEach((chip) => {
      chip.addEventListener('click', () => {
        typeFilter = chip.dataset.type;
        regalFilters.type = typeFilter;
        chips.querySelectorAll('[data-type]').forEach((c) => c.classList.toggle('is-on', c === chip));
        renderGames();
      });
    });
    chips.querySelectorAll('[data-dur]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const d = chip.dataset.dur;
        if (durFilter.has(d)) durFilter.delete(d);
        else durFilter.add(d);
        chip.classList.toggle('is-on', durFilter.has(d));
        renderGames();
      });
    });
    gamesSec.appendChild(chips);

    // Build the cards once and remember them by game id. When re-sorting we only
    // reorder these existing nodes – no page rebuild that would reset the scroll.
    const cardById = {};
    activeGames.forEach((g) => {
      const imgStyle = g.image ? `style="background-image:url('${g.image}')"` : '';
      const fallback = g.image
        ? ''
        : `<i class="ti ${typeIcon(g.type)}" aria-hidden="true"></i>`;
      const avg = avgMap[g.id];
      const scorePill =
        avg !== null
          ? `<span class="score-pill" style="background:${avgColor(avg)}">Ø ${avg.toFixed(1)}</span>`
          : `<span class="score-pill score-pill--none">${esc(t('games.scoreNew'))}</span>`;
      const gc = h(`<div class="game-card game-card--clickable">
           <div class="game-card__img" ${imgStyle}>${fallback}
             <div class="game-card__badges">${scorePill}${typeBadge(g.type)}${durationBadge(g.duration)}</div>
           </div>
           <div class="game-card__body">
             <div class="game-card__title">${esc(g.title)}</div>
           </div>
         </div>`);
      gc.addEventListener('click', () => showGameDetail(rid, g.id));
      cardById[g.id] = gc;
    });
    gamesSec.appendChild(grid);

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
    function matchesFilters(g) {
      if (typeFilter !== 'all' && g.type !== typeFilter) return false;
      if (durFilter.size && !durFilter.has(g.duration)) return false;
      const q = query.trim().toLowerCase();
      if (q && !g.title.toLowerCase().includes(q)) return false;
      return true;
    }
    // Reorder/filter the existing card nodes (no page rebuild); the add tile
    // always closes the grid.
    function renderGames() {
      const cards = orderedGames().filter(matchesFilters).map((g) => cardById[g.id]);
      if (cards.length === 0) {
        const msg = query.trim()
          ? t('games.noMatch', { q: query.trim() })
          : t('games.noMatchFilters');
        grid.replaceChildren(h(`<div class="muted games-nomatch">${esc(msg)}</div>`), addTile);
        return;
      }
      grid.replaceChildren(...cards, addTile);
    }

    searchInput.addEventListener('input', () => {
      query = searchInput.value;
      regalFilters.query = query;
      renderGames();
    });
    sortSel.addEventListener('change', () => {
      gamesSort = sortSel.value;
      renderGames();
    });
    renderGames();
  }
  app.appendChild(gamesSec);

  // Quiet footer: the way into the archive of retired games.
  const retiredGames = round.games.filter((g) => g.retired);
  const foot = h('<div class="round-footer"></div>');
  const retiredBtn = h(`<button class="link-btn"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('retired.link', { n: retiredGames.length }))}</button>`);
  retiredBtn.addEventListener('click', () => showRetired(round.id));
  foot.appendChild(retiredBtn);
  app.appendChild(foot);
}

// --- Chronik tab: one timeline of sessions and shelf changes.
function renderChronikTab(round) {
  const rid = round.id;

  // Collect all entries: done sessions as cards, game activities as quiet rows.
  const entries = [];
  round.sessions
    .filter((s) => s.done)
    .forEach((s) => entries.push({ kind: 'session', at: s.createdAt, session: s }));
  (round.activities || []).forEach((a) => {
    const meta = {
      game_added: { icon: 'ti-plus', text: t('activity.gameAdded', { title: a.title }) },
      game_retired: { icon: 'ti-trash', text: t('activity.gameRetired', { title: a.title }) },
      game_restored: { icon: 'ti-arrow-back-up', text: t('activity.gameRestored', { title: a.title }) },
      game_deleted: { icon: 'ti-trash', text: t('activity.gameDeleted', { title: a.title }) },
    }[a.type];
    if (!meta) return;
    entries.push({ kind: 'activity', at: a.at, id: a.id, gameId: a.gameId, type: a.type, ...meta });
  });
  entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const sec = h('<div class="section"></div>');
  sec.appendChild(h(`<div class="section-head"><h3>${esc(t('chronik.title'))}</h3></div>`));

  // Filter chips: everything / sessions only / shelf changes only.
  let filter = 'all';
  const chips = h(`<div class="filter-chips">
      <button class="chip is-on" data-f="all">${esc(t('chronik.filter.all'))}</button>
      <button class="chip" data-f="sessions"><i class="ti ti-confetti" aria-hidden="true"></i>${esc(t('chronik.filter.sessions'))}</button>
      <button class="chip" data-f="changes"><i class="ti ti-cards" aria-hidden="true"></i>${esc(t('chronik.filter.changes'))}</button>
    </div>`);
  chips.querySelectorAll('[data-f]').forEach((chip) => {
    chip.addEventListener('click', () => {
      filter = chip.dataset.f;
      chips.querySelectorAll('[data-f]').forEach((c) => c.classList.toggle('is-on', c === chip));
      renderTimeline();
    });
  });
  sec.appendChild(chips);

  const tl = h('<div class="timeline"></div>');
  sec.appendChild(tl);
  app.appendChild(sec);

  function buildSessionCard(s) {
    const when = fmtDateTime(s.createdAt);
    const chosen = s.chosenGameId && round.games.find((g) => g.id === s.chosenGameId);
    const winnerNames = (s.winnerIds || [])
      .map((wid) => (round.members.find((m) => m.id === wid) || {}).name)
      .filter(Boolean);

    // Thumbnail: the chosen game's cover, or an icon for the session's state.
    const thumbStyle = chosen && chosen.image ? `style="background-image:url('${chosen.image}')"` : '';
    const thumbIcon = chosen
      ? chosen.image ? '' : `<i class="ti ${typeIcon(chosen.type)}" aria-hidden="true"></i>`
      : `<i class="ti ${s.cancelled ? 'ti-x' : 'ti-cards'}" aria-hidden="true"></i>`;

    // Headline is the chosen game (with a rating pill); the date leads only
    // when no game was played. The meta line carries the rest.
    const title = chosen ? esc(chosen.title) : esc(when);
    let pill = '';
    if (chosen) {
      const sst = gameStatsForSession(round, s, chosen.id);
      if (sst.avg !== null) pill = `<span class="score-pill" style="background:${avgColor(sst.avg)}">Ø ${sst.avg.toFixed(1)}</span>`;
    }

    const parts = [];
    if (chosen) parts.push(esc(when));
    if (s.finished) parts.push(winnerNames.length ? '<i class="ti ti-trophy" aria-hidden="true"></i> ' + winnerNames.map(esc).join(', ') : iconText('ti-check', t('sessions.played')));
    else if (s.cancelled) parts.push(`<span style="color:var(--danger)">${iconText('ti-x', t('sessions.cancelled'))}</span>`);
    parts.push(esc(t('sessions.rated', { n: s.gameIds.length })));

    const card = h(`<button class="session-card">
         <div class="session-card__img" ${thumbStyle}>${thumbIcon}</div>
         <div class="session-card__body">
           <div class="session-card__title">${title}${pill}</div>
           <div class="session-card__meta">${parts.join(' · ')}</div>
         </div>
       </button>`);
    card.addEventListener('click', () => showResults(round, s));
    return card;
  }

  function buildActivityRow(e) {
    // Navigate to the game (if it still exists) or to the archive.
    const gameExists = e.gameId && round.games.some((g) => g.id === e.gameId);
    const nav =
      e.type === 'game_retired'
        ? () => showRetired(rid)
        : gameExists
          ? () => showGameDetail(rid, e.gameId)
          : null;
    const row = h(`<div class="tl-act${nav ? ' tl-act--link' : ''}">
         <span class="tl-act__icon"><i class="ti ${e.icon}" aria-hidden="true"></i></span>
         <span class="tl-act__text">${esc(e.text)}</span>
         <span class="tl-act__time">${fmtDateTime(e.at)}</span>
         <button class="tl-act__del" title="${esc(t('activity.delete'))}" aria-label="${esc(t('activity.delete'))}"><i class="ti ti-x" aria-hidden="true"></i></button>
       </div>`);
    if (nav) {
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('.tl-act__del')) return; // delete is not "open"
        nav();
      });
    }
    row.querySelector('.tl-act__del').addEventListener('click', async () => {
      if (!confirm(t('activity.deleteConfirm'))) return;
      try {
        await api('DELETE', `/api/rounds/${rid}/activities/${e.id}`);
        toast(t('activity.deleted'));
        showRound(rid, 'chronik');
      } catch (err) { toast(err.message); }
    });
    return row;
  }

  // Month-grouped timeline, newest first.
  function renderTimeline() {
    tl.innerHTML = '';
    const visible = entries.filter((e) =>
      filter === 'all' ? true : filter === 'sessions' ? e.kind === 'session' : e.kind === 'activity'
    );
    if (visible.length === 0) {
      tl.appendChild(h(`<div class="muted">${esc(t('chronik.empty'))}</div>`));
      return;
    }
    let lastMonth = '';
    visible.forEach((e) => {
      const month = fmtMonth(e.at);
      if (month !== lastMonth) {
        lastMonth = month;
        tl.appendChild(h(`<div class="tl-month">${esc(month)}</div>`));
      }
      const item = h(`<div class="tl-item"><span class="tl-dot${e.kind === 'session' ? ' tl-dot--session' : ''}"></span></div>`);
      item.appendChild(e.kind === 'session' ? buildSessionCard(e.session) : buildActivityRow(e));
      tl.appendChild(item);
    });
  }
  renderTimeline();

  // Utility footer: deleting the round lives with its history, out of the way.
  const footer = h('<div class="round-footer"></div>');
  const delBtn = h(`<button class="link-btn round-footer__danger">${esc(t('round.deleteRound'))}</button>`);
  delBtn.addEventListener('click', async () => {
    if (!confirm(t('round.deleteConfirm', { name: round.name }))) return;
    await api('DELETE', '/api/rounds/' + rid);
    showHome();
  });
  footer.appendChild(delBtn);
  app.appendChild(footer);
}

// --- Pokale tab: hall of fame — member podium and fun stats, all computed
// on demand from sessions (single source of truth, like the rating averages).
function renderPokaleTab(round) {
  const finished = round.sessions.filter((s) => s.finished);

  const sec = h('<div class="section"></div>');
  sec.appendChild(h(`<div class="section-head"><h3>${esc(t('pokale.title'))}</h3></div>`));

  if (finished.length === 0) {
    sec.appendChild(h(`<div class="empty"><p>${esc(t('pokale.empty'))}</p></div>`));
    app.appendChild(sec);
    return;
  }

  // Wins per member (a night can have several winners).
  const wins = {};
  round.members.forEach((m) => (wins[m.id] = 0));
  finished.forEach((s) =>
    (s.winnerIds || []).forEach((wid) => {
      if (wid in wins) wins[wid]++;
    })
  );
  const ranked = [...round.members].sort((a, b) => wins[b.id] - wins[a.id]);

  // Competition ranking (1224): members tied on wins share a rank, so two
  // three-win members are both rank 1 and the next best jumps to rank 3. Only
  // members who have actually won something can stand on the podium.
  const winners = ranked.filter((m) => wins[m.id] > 0);
  const rankOf = {};
  winners.forEach((m) => {
    rankOf[m.id] = winners.filter((o) => wins[o.id] > wins[m.id]).length + 1;
  });

  // Podium slots by rank: left = 2, center = 1, right = 3. A slot holds every
  // member with that rank, so a tie shows several avatars sharing one step.
  const podiumCol = (rank) => {
    const members = winners.filter((m) => rankOf[m.id] === rank);
    if (!members.length) return '';
    const avatars = members
      .map(
        (m) =>
          `<span class="avatar podium__avatar" data-mid="${esc(m.id)}" style="background:${memberColor(round, m.id)}">${esc(initials(m.name))}</span>`
      )
      .join('');
    const names = members.map((m) => esc(m.name)).join(', ');
    return `<div class="podium__col podium__col--${rank}">
             ${rank === 1 ? '<i class="ti ti-crown podium__crown" aria-hidden="true"></i>' : ''}
             <span class="podium__avatars">${avatars}</span>
             <span class="podium__name">${names}</span>
             <span class="podium__base"><span class="podium__rank">${rank}</span>${esc(tn(wins[members[0].id], 'pokale.winsOne', 'pokale.wins'))}</span>
           </div>`;
  };
  if (winners.length) {
    const podium = h(`<div class="podium">${podiumCol(2)}${podiumCol(1)}${podiumCol(3)}</div>`);
    // Each podium avatar opens that member's detail page.
    podium.querySelectorAll('.podium__avatar[data-mid]').forEach((el) => {
      makeMemberLink(el, round.id, el.dataset.mid);
    });
    sec.appendChild(podium);
  }
  // Anyone ranked below the podium's three steps drops to the summary line.
  const onPodium = new Set(winners.filter((m) => rankOf[m.id] <= 3).map((m) => m.id));
  const rest = ranked.filter((m) => !onPodium.has(m.id));
  if (rest.length) {
    const line = rest
      .map(
        (m) =>
          `<span class="podium__rest-name" data-mid="${esc(m.id)}">${esc(m.name)}</span> · ${esc(tn(wins[m.id], 'pokale.winsOne', 'pokale.wins'))}`
      )
      .join('&ensp;—&ensp;');
    const restEl = h(`<div class="muted podium__rest">${line}</div>`);
    restEl.querySelectorAll('.podium__rest-name[data-mid]').forEach((el) => {
      makeMemberLink(el, round.id, el.dataset.mid);
    });
    sec.appendChild(restEl);
  }

  const statCard = (icon, label, value, sub) =>
    h(`<div class="pokale-card">
         <span class="pokale-card__icon"><i class="ti ${icon}" aria-hidden="true"></i></span>
         <span class="pokale-card__label">${esc(label)}</span>
         <span class="pokale-card__value">${esc(value)}</span>
         <span class="pokale-card__sub">${esc(sub)}</span>
       </div>`);
  // Like statCard but the value is one or more games, each listed on its own row
  // with a "Jetzt spielen" launcher (icon-only; omitted for a retired game).
  const gameStatCard = (icon, label, games, sub) => {
    const card = h(`<div class="pokale-card">
         <span class="pokale-card__icon"><i class="ti ${icon}" aria-hidden="true"></i></span>
         <span class="pokale-card__label">${esc(label)}</span>
         <span class="pokale-card__games"></span>
         <span class="pokale-card__sub">${esc(sub)}</span>
       </div>`);
    const list = card.querySelector('.pokale-card__games');
    games.forEach((g) => {
      const row = h(`<span class="pokale-game">
           <span class="pokale-game__title">${esc(g.title)}</span>
         </span>`);
      // The game name opens its detail page (retired games too — the detail
      // view supports them; only the "Jetzt spielen" launcher is omitted).
      makeGameLink(row.querySelector('.pokale-game__title'), round.id, g.id);
      if (!g.retired) {
        const btn = h(`<button class="pokale-game__play" title="${esc(t('directPlay.button'))}" aria-label="${esc(t('directPlay.button'))}"><i class="ti ti-player-play" aria-hidden="true"></i></button>`);
        btn.addEventListener('click', () => startDirectSession(round, g));
        row.appendChild(btn);
      }
      list.appendChild(row);
    });
    return card;
  };
  const cards = h('<div class="pokale-cards"></div>');

  // Most played: chosen most often across finished nights (game must exist).
  const playCount = {};
  finished.forEach((s) => {
    if (s.chosenGameId && round.games.some((g) => g.id === s.chosenGameId))
      playCount[s.chosenGameId] = (playCount[s.chosenGameId] || 0) + 1;
  });
  let maxPlays = 0;
  Object.keys(playCount).forEach((gid) => {
    if (playCount[gid] > maxPlays) maxPlays = playCount[gid];
  });
  const mostGames = Object.keys(playCount)
    .filter((gid) => playCount[gid] === maxPlays)
    .map((gid) => round.games.find((x) => x.id === gid));
  if (mostGames.length) {
    cards.appendChild(
      gameStatCard('ti-flame', t('pokale.mostPlayed'), mostGames, tn(maxPlays, 'home.chip.sessionsOne', 'home.chip.sessions'))
    );
  }

  // Best rated: highest overall average with a bit of data behind it; ties
  // share the tile.
  const rated = round.games
    .filter((g) => !g.retired)
    .map((g) => {
      const st = gameStats(round, g.id);
      return { g, avg: st.avg, count: st.count };
    })
    .filter((x) => x.avg !== null && x.count >= 3);
  if (rated.length) {
    const bestAvg = Math.max(...rated.map((x) => x.avg));
    const bestGames = rated.filter((x) => x.avg === bestAvg).map((x) => x.g);
    cards.appendChild(gameStatCard('ti-star', t('pokale.bestRated'), bestGames, `Ø ${bestAvg.toFixed(1)}`));
  }

  // Streak: how many of the latest nights in a row one member won alone.
  const chrono = [...finished].sort((a, b) =>
    String(a.finishedAt || a.createdAt).localeCompare(String(b.finishedAt || b.createdAt))
  );
  let streakMember = null;
  let streak = 0;
  for (let i = chrono.length - 1; i >= 0; i--) {
    const ws = chrono[i].winnerIds || [];
    if (streakMember === null) {
      if (ws.length !== 1) break;
      streakMember = ws[0];
      streak = 1;
    } else if (ws.length === 1 && ws[0] === streakMember) {
      streak++;
    } else break;
  }
  const streakM = streakMember && round.members.find((m) => m.id === streakMember);
  if (streakM && streak >= 2) {
    const streakCard = statCard('ti-bolt', t('pokale.streak'), streakM.name, t('pokale.streakN', { n: streak }));
    // Link the member name to their detail page, like the podium members above.
    makeMemberLink(streakCard.querySelector('.pokale-card__value'), round.id, streakMember);
    cards.appendChild(streakCard);
  }

  // Gathering dust: the active game whose last night is longest ago (or never).
  const lastAt = {};
  finished.forEach((s) => {
    if (!s.chosenGameId) return;
    const at = s.finishedAt || s.createdAt;
    if (!lastAt[s.chosenGameId] || at > lastAt[s.chosenGameId]) lastAt[s.chosenGameId] = at;
  });
  const active = round.games.filter((g) => !g.retired);
  // Find the earliest last-played timestamp ('' = never played sorts first),
  // then pick a random game among all that tie for it, so the same game isn't
  // always highlighted.
  let dustyAt = null;
  active.forEach((g) => {
    const at = lastAt[g.id] || '';
    if (dustyAt === null || at < dustyAt) dustyAt = at;
  });
  const dustyCandidates = active.filter((g) => (lastAt[g.id] || '') === dustyAt);
  const dusty = dustyCandidates.length
    ? { g: dustyCandidates[Math.floor(Math.random() * dustyCandidates.length)], at: dustyAt }
    : null;
  if (dusty && active.length > 1) {
    cards.appendChild(
      gameStatCard(
        'ti-sparkles',
        t('pokale.dusty'),
        [dusty.g],
        dusty.at ? t('pokale.dustyAt', { when: fmtMonth(dusty.at) }) : t('pokale.dustyNever')
      )
    );
  }

  if (cards.children.length) sec.appendChild(cards);
  app.appendChild(sec);
}

// =================== Retired games ===================

async function showRetired(rid) {
  currentView = () => showRetired(rid);
  syncUrl(`/round/${rid}/retired`);
  app.innerHTML = '<p class="muted">…</p>';
  let round;
  try { round = await api('GET', '/api/rounds/' + rid); }
  catch { return showHome(); }
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
    const list = h('<div class="archive-list"></div>');
    games.forEach((g) => {
      const imgStyle = g.image ? ` style="background-image:url('${g.image}')"` : '';
      const fallback = g.image
        ? ''
        : `<i class="ti ${typeIcon(g.type)}" aria-hidden="true"></i>`;
      const when = g.retiredAt ? fmtDateTime(g.retiredAt) : '?';
      const row = h(`<div class="archive-row">
           <div class="archive-row__img"${imgStyle}>${fallback}</div>
           <div class="archive-row__body">
             <div class="archive-row__title">${esc(g.title)} ${typeTag(g.type)} ${durationTag(g.duration)}</div>
             <div class="muted archive-row__meta"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('retired.at', { when }))}</div>
           </div>
           <div class="archive-row__actions">
             <button class="btn" data-act="restore"><i class="ti ti-arrow-back-up" aria-hidden="true"></i> ${esc(t('retired.restore'))}</button>
             <button class="btn btn--danger" data-act="delete"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('retired.delete'))}</button>
           </div>
         </div>`);
      row.querySelector('[data-act="restore"]').addEventListener('click', async () => {
        try {
          await api('POST', `/api/rounds/${rid}/games/${g.id}/retire`, { retired: false });
          toast(t('retired.restored', { title: g.title }));
          showRetired(rid);
        } catch (e) { toast(e.message); }
      });
      row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!confirm(t('retired.deleteConfirm', { title: g.title }))) return;
        try {
          await api('DELETE', `/api/rounds/${rid}/games/${g.id}`);
          toast(t('retired.deleted', { title: g.title }));
          showRetired(rid);
        } catch (e) { toast(e.message); }
      });
      list.appendChild(row);
    });
    app.appendChild(list);
  }

  const back = h(`<div class="section center"><button class="btn btn--lg">${esc(t('common.back'))}</button></div>`);
  back.querySelector('button').addEventListener('click', () => navBack(() => showRound(rid, 'regal')));
  app.appendChild(back);
}

// =================== Design ===================

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
  try { round = await api('GET', '/api/rounds/' + rid); }
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

// =================== Game detail ===================

async function showGameDetail(rid, gameId) {
  currentView = () => showGameDetail(rid, gameId);
  syncUrl(`/round/${rid}/game/${gameId}`);
  app.innerHTML = '<p class="muted">…</p>';
  let round;
  try { round = await api('GET', '/api/rounds/' + rid); }
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
    : `<i class="ti ${typeIcon(game.type)}" aria-hidden="true"></i>`;
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

  // Platform tag (editable). Switching to a concrete platform derives the type;
  // switching to Other seeds it from the current type and reveals a second,
  // editable analog/digital tag so Other games keep a manual type.
  const platform = gamePlatform(game);
  const platEl = h(platformTag(platform));
  makeEditableTag(platEl, () => openMenu(platEl,
    PLATFORM_IDS.map((p) => ({ value: p, label: t('platform.' + p) })),
    platform,
    (v) => updateGame(v === 'other' ? { platform: 'other', type: game.type } : { platform: v })));

  let typeEl = null;
  if (platform === 'other') {
    typeEl = h(typeTag(game.type));
    makeEditableTag(typeEl, () => openMenu(typeEl, [
      { value: 'analog', label: t('type.analog') },
      { value: 'digital', label: t('type.digital') },
    ], game.type, (v) => updateGame({ type: v })));
  }

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

  h1.append(platEl, space());
  if (typeEl) h1.append(typeEl, space());
  h1.append(durEl, space(), plEl);
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
// A provider's game type: BoardGameGeek is analog, every store is digital.
function lookupProviderType(provider) {
  return provider === 'bgg' ? 'analog' : 'digital';
}

// --- Platform (Analog / PS / Xbox / Switch / Steam / Other) ---
// The user-facing platform field. `type` (analog/digital) is derived from it for
// the five concrete platforms; only `other` keeps a manual analog/digital choice.
const PLATFORM_IDS = ['analog', 'ps', 'xbox', 'switch', 'steam', 'other'];
// Platform id → the brand-logo provider key (ids differ: ps↔psstore, switch↔nintendo).
const PLATFORM_PROVIDER = { ps: 'psstore', xbox: 'xbox', switch: 'nintendo', steam: 'steam' };
// The platform a picked lookup hit implies, from its provider (add-game auto-fill).
function providerPlatform(provider) {
  return { psstore: 'ps', xbox: 'xbox', nintendo: 'switch', steam: 'steam', bgg: 'analog' }[provider] || 'other';
}
// Derived analog/digital type for a platform (Other defaults to analog).
function platformType(platform) {
  return platform === 'ps' || platform === 'xbox' || platform === 'switch' || platform === 'steam'
    ? 'digital'
    : 'analog';
}
// Brand glyph (the four stores) or null (analog/other use a Tabler icon instead).
function platformLogo(platform) {
  return PLATFORM_PROVIDER[platform] ? providerLogo(PLATFORM_PROVIDER[platform]) : null;
}
// Tabler icon for the non-branded platforms.
function platformIcon(platform) {
  return platform === 'analog' ? 'ti-dice-3' : 'ti-device-gamepad-2';
}
// A tag showing a game's platform: brand glyph for the four stores, a Tabler
// icon for analog/other. Brand glyphs are the sanctioned hardcoded-color
// exception (see .claude/rules/theme-derived-colors.md).
function platformTag(platform) {
  const logo = platformLogo(platform);
  const mark = logo
    ? `<span class="tag__logo" aria-hidden="true">${logo}</span>`
    : `<i class="ti ${platformIcon(platform)}" aria-hidden="true"></i>`;
  return `<span class="tag tag--platform">${mark} ${t('platform.' + platform)}</span>`;
}
// The platform an existing game should display: its stored field, or a defensive
// fallback for any legacy game written before the field existed.
function gamePlatform(game) {
  if (PLATFORM_IDS.includes(game.platform)) return game.platform;
  return game.type === 'digital' ? 'other' : 'analog';
}

// The lookup queries every provider in parallel and merges the hits into one
// menu, each result carrying its own provider. Providers are rendered
// *progressively* (a fast provider's hits show before a slow one settles) and
// the merged list is ranked by how well each title matches the query, re-sorted
// in place as each provider arrives. One provider failing must not hide the
// others' results — only an all-providers failure shows the error state.
const LOOKUP_PROVIDERS = ['psstore', 'bgg', 'steam', 'nintendo', 'xbox'];
const MAX_SUGGESTIONS = 10;

async function searchProvider(provider, q) {
  const res = await api('GET', `/api/lookup/search?provider=${provider}&q=${encodeURIComponent(q)}&lang=${encodeURIComponent(getLocale())}`);
  return ((res && res.results) || []).map((r) => Object.assign({ provider }, r));
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
// (e.g. for a prefilled value on open). Shared by showAddGame and
// showLinkProvider so the two lookups stay in sync.
function attachLookup(input, menu, onPick, onInput) {
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
    let pending = LOOKUP_PROVIDERS.length;
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
          : `<span class="lookup__thumb lookup__thumb--none" aria-hidden="true"><i class="ti ${typeIcon(lookupProviderType(g.primary.provider))}"></i></span>`;
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

    LOOKUP_PROVIDERS.forEach((provider, prio) => {
      searchProvider(provider, q).then((list) => {
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
          <label>${esc(t('addGame.platformLabel'))}</label>
          <div class="opt-cards opt-cards--platform" id="platformSeg"></div>
          <div class="field field--sub" id="otherTypeField" hidden>
            <label>${esc(t('addGame.typeLabel'))}</label>
            <div class="opt-cards" id="typeSeg">
              <button type="button" class="opt-card" data-type="analog"><i class="ti ti-dice-3" aria-hidden="true"></i>${esc(t('type.analog'))}</button>
              <button type="button" class="opt-card is-on" data-type="digital"><i class="ti ti-device-gamepad-2" aria-hidden="true"></i>${esc(t('type.digital'))}</button>
            </div>
          </div>
        </div>
        <div class="field">
          <label>${esc(t('addGame.durationLabel'))}</label>
          <div class="filter-chips" id="durationSeg">
            <button type="button" class="chip" data-duration="short"><i class="ti ti-bolt" aria-hidden="true"></i>${esc(t('duration.short'))}</button>
            <button type="button" class="chip is-on" data-duration="medium"><i class="ti ti-clock" aria-hidden="true"></i>${esc(t('duration.medium'))}</button>
            <button type="button" class="chip" data-duration="long"><i class="ti ti-hourglass" aria-hidden="true"></i>${esc(t('duration.long'))}</button>
          </div>
          <div class="muted field__hint">${esc(t('addGame.durationHint'))}</div>
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

  // Platform selector; `type` is derived from it (only Other reveals a manual
  // analog/digital sub-control).
  let platform = 'analog';
  let type = 'analog';
  const platformSeg = form.querySelector('#platformSeg');
  const otherTypeField = form.querySelector('#otherTypeField');
  const typeSeg = form.querySelector('#typeSeg');
  platformSeg.innerHTML = PLATFORM_IDS.map((p) => {
    const logo = platformLogo(p);
    const mark = logo
      ? `<span class="opt-card__logo" aria-hidden="true">${logo}</span>`
      : `<i class="ti ${platformIcon(p)}" aria-hidden="true"></i>`;
    return `<button type="button" class="opt-card${p === 'analog' ? ' is-on' : ''}" data-platform="${p}">${mark}${esc(t('platform.' + p))}</button>`;
  }).join('');

  function selectPlatform(p) {
    platform = p;
    platformSeg.querySelectorAll('.opt-card').forEach((c) => c.classList.toggle('is-on', c.dataset.platform === p));
    otherTypeField.hidden = p !== 'other';
    // Concrete platforms derive the type; Other keeps whatever the sub-control shows.
    type = p === 'other' ? typeSeg.querySelector('.opt-card.is-on').dataset.type : platformType(p);
  }
  platformSeg.querySelectorAll('.opt-card').forEach((card) => {
    card.addEventListener('click', () => selectPlatform(card.dataset.platform));
  });
  typeSeg.querySelectorAll('.opt-card').forEach((card) => {
    card.addEventListener('click', () => {
      typeSeg.querySelectorAll('.opt-card').forEach((c) => c.classList.toggle('is-on', c === card));
      type = card.dataset.type;
    });
  });

  let duration = 'medium';
  const durSeg = form.querySelector('#durationSeg');
  durSeg.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      durSeg.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-on', c === chip));
      duration = chip.dataset.duration;
    });
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

  // Fill the duration/player controls from a provider detail object. The type is
  // not set here — it follows the platform, which pickSuggestion sets from the
  // provider.
  function applyDetail(d) {
    if (d.duration) {
      duration = d.duration;
      durSeg.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-on', c.dataset.duration === duration));
    }
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
    // Pre-fill the platform from the provider so it's right even if the detail
    // call fails (BoardGameGeek → Analog, each store → its platform); the type
    // follows. A store cover comes from the search thumbnail; a BGG cover
    // arrives with the detail call.
    selectPlatform(providerPlatform(r.provider));
    if (r.thumbnail && !pastedBlob) showProviderImage(r.thumbnail);
    let d;
    try {
      d = await api('GET', `/api/lookup/game?provider=${encodeURIComponent(r.provider)}&id=${encodeURIComponent(r.providerId)}&lang=${encodeURIComponent(getLocale())}`);
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
  lookup = attachLookup(titleInput, menu, pickSuggestion, () => { chosenSource = null; });

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
    fd.append('platform', platform);
    fd.append('type', type);
    fd.append('duration', duration);
    fd.append('minPlayers', minPlayers);
    fd.append('maxPlayers', maxPlayers);
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
        // Keep the sheet open for the next game; type/duration/players stay.
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
    } catch (e) { toast(e.message); }
  }
  form.querySelector('#save').addEventListener('click', () => save(false));
  form.querySelector('#saveMore').addEventListener('click', () => save(true));
  form.querySelector('#title').focus();
}

// =================== Link an existing game to a provider (issue #74) ===================

// Sheet for attaching a provider to a game that has no source yet: search the
// providers (prefilled with the game's title), pick a match, then choose which
// differing fields (cover, players, duration, type) to overwrite. The source
// link is always saved; the field overrides default to "take everything".
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
  const lookup = attachLookup(input, menu, pickSuggestion, () => { resultBox.innerHTML = ''; });
  // The title is already filled in, so search for it right away — setting
  // input.value above doesn't fire an 'input' event, so trigger it explicitly.
  lookup.search(game.title);

  async function pickSuggestion(r) {
    lookup.closeMenu();
    input.value = r.title;
    resultBox.innerHTML = `<div class="section muted">${esc(t('lookup.searching'))}</div>`;
    let d;
    try {
      d = await api('GET', `/api/lookup/game?provider=${encodeURIComponent(r.provider)}&id=${encodeURIComponent(r.providerId)}&lang=${encodeURIComponent(getLocale())}`);
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
    if (d.imageUrl) fields.push({ key: 'image', label: t('linkProvider.field.image') });
    if ((Number.isInteger(d.minPlayers) && d.minPlayers !== game.minPlayers) ||
        (Number.isInteger(d.maxPlayers) && d.maxPlayers !== game.maxPlayers))
      fields.push({ key: 'players', label: t('linkProvider.field.players') });
    if (d.duration && d.duration !== game.duration)
      fields.push({ key: 'duration', label: t('linkProvider.field.duration') });
    if (lookupProviderType(r.provider) !== game.type)
      fields.push({ key: 'type', label: t('linkProvider.field.type') });

    resultBox.innerHTML = '';
    const box = h('<div class="section"></div>');
    box.appendChild(h(`<div class="link-match"><strong>${esc(d.title || r.title)}</strong> · ${esc(providerLabel(r.provider))}</div>`));

    let chips = null;
    if (fields.length) {
      box.appendChild(h(`<div class="muted field__hint" style="margin:10px 0 6px">${esc(t('linkProvider.overridePrompt'))}</div>`));
      chips = h('<div class="filter-chips"></div>');
      fields.forEach((f) => {
        const chip = h(`<button type="button" class="chip is-on" data-field="${f.key}"><i class="ti ti-check" aria-hidden="true"></i>${esc(f.label)}</button>`);
        chip.addEventListener('click', () => chip.classList.toggle('is-on'));
        chips.appendChild(chip);
      });
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
    if (isOn(chips, 'image') && d.imageUrl) body.imageUrl = d.imageUrl;
    if (isOn(chips, 'players')) {
      if (Number.isInteger(d.minPlayers)) body.minPlayers = d.minPlayers;
      if (Number.isInteger(d.maxPlayers)) body.maxPlayers = d.maxPlayers;
    }
    if (isOn(chips, 'duration') && d.duration) body.duration = d.duration;
    if (isOn(chips, 'type')) body.type = lookupProviderType(r.provider);
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
