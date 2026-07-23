/* Spielwirbel – views: the round hub (Start / Regal / Chronik / Pokale dock)
   and the Start tab (launchpad + buy-next). The other round concerns live in
   sibling files loaded right after this one: views-round-tabs.js (Regal /
   Chronik / Pokale / retired), views-round-detail.js (game detail, design,
   sheet helpers) and views-round-lookup.js (provider lookup + add/link game).
   Part of the frontend; all files share one global script scope. */

// =================== Round: hub (Start / Regal / Chronik) ===================

// The round screen is a hub with tabs, presented per device (#331): a floating
// dock at the bottom on phones, an in-flow strip at the top of the content
// column on desktop.
const HUB_TABS = ['start', 'regal', 'chronik', 'pokale'];

// Which hub tab owns each round SUB-screen, so those screens can show the
// section they belong to instead of being orphans of it. Keyed the way the
// router names them (resolveRoute in router.js), so a new sub-screen that
// forgets its entry here simply renders no strip rather than a wrong one.
const HUB_TAB_OF = {
  regal: ['game', 'retired', 'completed'],
  chronik: ['session'],
  start: ['member', 'design', 'tags', 'providers'],
};
const hubTabOwning = (sub) =>
  HUB_TABS.find((tab) => (HUB_TAB_OF[tab] || []).includes(sub)) || 'start';

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
  setContext(round.name);

  app.innerHTML = '';
  const activeGames = round.games.filter((g) => !g.retired && !g.completed);
  if (activeTab === 'regal') renderRegalTab(round, activeGames);
  else if (activeTab === 'chronik') renderChronikTab(round, activities);
  else if (activeTab === 'pokale') renderPokaleTab(round);
  else renderStartTab(round, activeGames);
  renderHubTabs(round, activeTab);
}

// The hub's tab bar. ONE element with two presentations, branched in CSS by
// viewport width alone (#331): below the strip breakpoint it is the floating
// bottom dock it has always been; above it, an in-flow strip at the top of the
// content column, where sibling sections of one entity belong.
//
// It is PREPENDED for that reason. On a phone the element is `position: fixed`,
// so its position in the DOM is inert there and the dock looks exactly as
// before — but on desktop it has to precede the tab content, and putting the
// navigation before the content is the better reading/tab order either way.
//
// `sub` marks a round sub-screen (game detail, tags, design, …). Those get the
// desktop strip, so they stop being orphans with no section context — but never
// the phone dock: it has never floated there, and starting now would put a
// fixed element and 120px of clearance onto eight more screens, which is the
// opposite of what this issue cleans up. `.dock--sub` is what CSS keys that on.
//
// From 1280px up BOTH of those give way to the rail (js/round-rail.js), which
// takes navigation out of the content column entirely. All three presentations
// are rendered and CSS shows exactly one, so a resize never needs a re-render.
// Takes the whole `round` because the rail carries its identity and counts, not
// just its id.
function renderHubTabs(round, activeTab, sub) {
  const rid = round.id;
  const tabs = [
    { id: 'start', icon: 'ti-home', label: t('hub.tab.start') },
    { id: 'regal', icon: 'ti-cards', label: t('hub.tab.regal') },
    { id: 'chronik', icon: 'ti-history', label: t('hub.tab.chronik') },
    { id: 'pokale', icon: 'ti-trophy', label: t('hub.tab.pokale') },
  ];
  const dock = h(`<nav class="dock${sub ? ' dock--sub' : ''}" aria-label="${esc(t('a11y.hubTabs'))}"></nav>`);
  tabs.forEach(({ id: tabId, icon, label }) => {
    // aria-current marks the tab you are on (#145). It was signalled by the
    // is-active class alone, i.e. by color — and since the active tab also does
    // nothing when clicked, a screen-reader user met a dead control with no
    // clue why.
    //
    // On a sub-screen it is "true", not "page": that tab is the section you are
    // inside, but it is emphatically not the page you are on, and saying "page"
    // would announce the game detail screen as if it were the Regal.
    const active = tabId === activeTab;
    const current = sub ? 'true' : 'page';
    const item = h(`<a class="dock__item${active ? ' is-active' : ''}"${active ? ` aria-current="${current}"` : ''}>
         <i class="ti ${icon}" aria-hidden="true"></i>${esc(label)}
       </a>`);
    // Every tab carries its href, so any of them can be copied or opened in a
    // new tab — but on a hub tab the active one stays click-inert (no onNav),
    // because it points at the screen you are already on and a real navigation
    // there would be a full page reload. On a sub-screen the owning tab is a
    // live link: clicking it is how you get back up to that section.
    navLink(item, roundPath(rid, tabId), active && !sub ? null : () => showRound(rid, tabId));
    dock.appendChild(item);
  });
  // Rail first, so it is the column's first child and the dock the second —
  // both inert in the presentation where CSS hides them.
  app.prepend(dock);
  app.prepend(buildRoundRail(round, activeTab, sub));
}

// Prepend the desktop-only strip to a round sub-screen, marking the tab that
// owns it. `sub` is the router's own path segment (see HUB_TAB_OF).
//
// The segment is passed THROUGH, not reduced to a boolean. The dock only ever
// asks "is this a sub-screen at all", so `true` was enough for it — but the rail
// gives five of those screens an entry of their own and has to know which one it
// is on. Collapsing it here made Tags/Provider/Design and both archives light up
// "Start" instead of themselves, which looks like a plausible answer and is not.
function renderSubScreenTabs(round, sub) {
  renderHubTabs(round, hubTabOwning(sub), sub);
}

// --- Start tab: the launchpad — identity, the one big CTA, the latest story.
function renderStartTab(round, activeGames) {
  const rid = round.id;

  // Stats per active game (for the retirement recommendations below).
  const statsByGame = {};
  activeGames.forEach((g) => (statsByGame[g.id] = gameStats(round, g.id)));

  const playedCount = round.sessions.filter((s) => s.finished).length;
  const hero = h(`<div class="hero rail-owned">
       <h1>${esc(round.name)}</h1>
       <div class="hero__members">${round.members
         .map((m) => `<a class="avatar" style="background:${memberColor(round, m.id)}" title="${esc(m.name)}">${esc(initials(m.name))}</a>`)
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
    `<button class="btn btn--primary hub-cta rail-owned"><i class="ti ti-tornado" aria-hidden="true"></i>${esc(t('round.startSession'))}</button>`
  );
  startBtn.addEventListener('click', () => showStartSession(round));
  if (activeGames.length === 0) {
    startBtn.disabled = true;
    startBtn.title = t('round.startSessionDisabled');
  }
  app.appendChild(startBtn);

  // "Vote in progress" tickets: a draw whose voting was abandoned before the
  // hot-seat wizard POSTed its results (#329). The row is created server-side at
  // draw time, so leaving mid-vote used to strand a `done: false` session that
  // no screen ever showed. Offered here instead — resuming re-enters the wizard
  // with the same drawn games (no vote was ever saved, so it honestly starts
  // over), and the discard deletes the row.
  // The draw stays secret until everyone has rated, so this ticket deliberately
  // shows neither cover nor title — only how many games were drawn.
  round.sessions
    .filter((s) => !s.done && !s.cancelled)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .forEach((session) => {
      const n = (session.gameIds || []).length;
      const ticket = h(`<button class="ticket ticket--live">
           <span class="ticket__main">
             <span class="ticket__img"><i class="ti ti-tornado" aria-hidden="true"></i></span>
             <span class="ticket__info">
               <span class="ticket__label">${esc(t('round.draftLabel'))}</span>
               <span class="ticket__title">${esc(tn(n, 'round.draftTitleOne', 'round.draftTitle'))}</span>
               <span class="ticket__meta">${esc(fmtDateTime(session.createdAt))}</span>
             </span>
           </span>
           <span class="ticket__stub">
             <i class="ti ti-player-play" aria-hidden="true"></i>
             <span class="ticket__names">${esc(t('round.resumeVote'))}</span>
           </span>
         </button>`);
      ticket.addEventListener('click', () => {
        const drawn = session.gameIds
          .map((gid) => round.games.find((g) => g.id === gid))
          .filter(Boolean);
        const voters = Array.isArray(session.memberIds)
          ? round.members.filter((m) => session.memberIds.includes(m.id))
          : round.members;
        // Games or members can have been deleted since the draw was abandoned,
        // leaving nothing to vote on — say so rather than opening an empty
        // wizard; the discard below is then the only sensible action.
        if (!drawn.length || !voters.length) return toast(t('round.toast.draftGone'));
        startVoting(round, session, drawn, voters);
      });
      app.appendChild(ticket);

      const discard = h(`<div class="center ticket__discard"><button class="link-btn">${esc(t('round.draftDiscard'))}</button></div>`);
      discard.querySelector('button').addEventListener('click', async () => {
        if (!confirm(t('round.draftDiscardConfirm'))) return;
        try {
          await api('DELETE', `/api/rounds/${round.id}/sessions/${session.id}`);
          toast(t('round.toast.draftDiscarded'));
          await fetchRoundFresh(round.id);
          showRound(round.id, 'start');
        } catch (e) { toast(e.message); }
      });
      app.appendChild(discard);
    });

  // "In progress" tickets: sessions whose voting is done but that have not yet
  // reached a final state (no winner recorded, not cancelled). Shown above the
  // last-played ticket, newest first; tapping resumes on the results screen.
  round.sessions
    .filter((s) => s.done && !s.finished && !s.cancelled)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .forEach((session) => {
      const game = session.chosenGameId && round.games.find((g) => g.id === session.chosenGameId);
      const when = fmtDateTime(session.chosenAt || session.createdAt);
      const imgStyle = game && game.image ? ` style="background-image:url('${coverUrl(game.image, COVER_THUMB)}')"` : '';
      const fallback = game
        ? coverPlaceholder(game)
        : '<i class="ti ti-tornado" aria-hidden="true"></i>';
      let pill = '';
      if (game) {
        const sst = gameStatsForSession(round, session, game.id);
        if (sst.avg !== null) pill = `<span class="score-pill" style="background:${avgColor(sst.avg)}">Ø ${sst.avg.toFixed(1)}</span>`;
      }
      const title = game ? esc(game.title) : esc(t('round.inProgressDeciding'));
      const ticket = h(`<a class="ticket ticket--live">
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
         </a>`);
      navLink(ticket, resultsPath(round.id, session.id), () => showResults(round, session));
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
    const imgStyle = game.image ? ` style="background-image:url('${coverUrl(game.image, COVER_THUMB)}')"` : '';
    const fallback = coverPlaceholder(game);
    const pill =
      sst.avg !== null
        ? `<span class="score-pill" style="background:${avgColor(sst.avg)}">Ø ${sst.avg.toFixed(1)}</span>`
        : '';
    const ticket = h(`<a class="ticket">
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
       </a>`);
    navLink(ticket, resultsPath(round.id, lastPlayed.id), () => showResults(round, lastPlayed));
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
             <a class="recommend-item__title">${esc(game.title)}</a>
             <span class="recommend-item__reason">${reasons.map(esc).join(' · ')}</span>
           </div>
           <button class="btn recommend-item__btn">${esc(t('rec.retire'))}</button>
         </div>`);
      navLink(item.querySelector('.recommend-item__title'), gamePath(round.id, game.id), () =>
        showGameDetail(round.id, game.id)
      );
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
  // Tags / Provider / Design are routed screens, so they are links (#330);
  // "Spiel hinzufügen" opens a sheet and stays a button.
  const tagsBtn = h(
    `<a class="btn rail-owned"><i class="ti ti-tags" aria-hidden="true"></i> ${esc(t('round.tags'))}</a>`
  );
  navLink(tagsBtn, roundPath(rid, 'tags'), () => showTags(rid));
  const providersBtn = h(
    `<a class="btn rail-owned"><i class="ti ti-world-search" aria-hidden="true"></i> ${esc(t('round.providers'))}</a>`
  );
  navLink(providersBtn, roundPath(rid, 'providers'), () => showProviders(rid));
  const bgBtn = h(
    `<a class="btn rail-owned"><i class="ti ti-palette" aria-hidden="true"></i> ${esc(t('round.design'))}</a>`
  );
  navLink(bgBtn, roundPath(rid, 'design'), () => showBackground(rid));
  actions.appendChild(addGameBtn);
  actions.appendChild(tagsBtn);
  actions.appendChild(providersBtn);
  actions.appendChild(bgBtn);
  app.appendChild(actions);
}

