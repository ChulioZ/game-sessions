/* Spielwirbel – views: the round hub (Start / Regal / Chronik / Pokale dock)
   and the Start tab (launchpad + buy-next). The other round concerns live in
   sibling files loaded right after this one: views-round-tabs.js (Regal /
   Chronik / Pokale / retired), views-round-detail.js (game detail, design,
   sheet helpers) and views-round-lookup.js (provider lookup + add/link game).
   Part of the frontend; all files share one global script scope. */

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
  // fall back to Home instead of hanging on the loading state. The activity
  // feed is not part of the round payload (#197); only Chronik renders it, so
  // fetch it just for that tab, in parallel with the round. A failed feed
  // fetch degrades to an empty feed (sessions still render) rather than
  // blocking the tab.
  let round, activities;
  try {
    [round, activities] = await Promise.all([
      fetchRound(rid),
      activeTab === 'chronik'
        ? fetchActivities(rid).catch(() => [])
        : [],
    ]);
  } catch { return showHome(); }
  applyBackground(round.background);
  setCrumbs([{ label: t('nav.home'), onClick: showHome }, { label: round.name }]);

  app.innerHTML = '';
  const activeGames = round.games.filter((g) => !g.retired);
  if (activeTab === 'regal') renderRegalTab(round, activeGames);
  else if (activeTab === 'chronik') renderChronikTab(round, activities);
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
    `<button class="btn btn--primary hub-cta"><i class="ti ti-tornado" aria-hidden="true"></i>${esc(t('round.startSession'))}</button>`
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
        ? coverPlaceholder(game)
        : '<i class="ti ti-tornado" aria-hidden="true"></i>';
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
  // Ordered by `createdAt` — when the session was played — so this agrees with
  // the Chronik; `finishedAt` changes when an old session is re-finished.
  const lastPlayed = round.sessions
    .filter((s) => s.finished && s.chosenGameId && round.games.some((g) => g.id === s.chosenGameId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (lastPlayed) {
    const game = round.games.find((g) => g.id === lastPlayed.chosenGameId);
    const winnerNames = (lastPlayed.winnerIds || [])
      .map((wid) => (round.members.find((m) => m.id === wid) || {}).name)
      .filter(Boolean);
    const sst = gameStatsForSession(round, lastPlayed, game.id);
    const when = fmtDateTime(lastPlayed.createdAt);
    const imgStyle = game.image ? ` style="background-image:url('${game.image}')"` : '';
    const fallback = coverPlaceholder(game);
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
             <span class="recommend-item__title">${esc(game.title)}</span>
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

  // Quick actions: quieter secondary tasks below the fold.
  const actions = h('<div class="hub-actions"></div>');
  const addGameBtn = h(
    `<button class="btn"><i class="ti ti-plus" aria-hidden="true"></i> ${esc(t('round.addGame'))}</button>`
  );
  addGameBtn.addEventListener('click', () => showAddGame(round));
  const tagsBtn = h(
    `<button class="btn"><i class="ti ti-tags" aria-hidden="true"></i> ${esc(t('round.tags'))}</button>`
  );
  tagsBtn.addEventListener('click', () => showTags(rid));
  const bgBtn = h(
    `<button class="btn"><i class="ti ti-palette" aria-hidden="true"></i> ${esc(t('round.design'))}</button>`
  );
  bgBtn.addEventListener('click', () => showBackground(rid));
  actions.appendChild(addGameBtn);
  actions.appendChild(tagsBtn);
  actions.appendChild(bgBtn);
  app.appendChild(actions);
}

