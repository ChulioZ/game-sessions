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
        ? game.image
          ? ''
          : `<i class="ti ${typeIcon(game.type)}" aria-hidden="true"></i>`
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

// Round ids whose Layer-B list should render expanded on the *next* render
// (issue #113). Set right before an internal re-render (generate / paging /
// delete) and cleared on read, so those keep the list open while a fresh entry
// to the round still starts collapsed.
const buyNextKeepOpen = new Set();

// Which run of the Layer-B history is shown per round (issue #115), keyed by
// round id -> run id. Survives the showRound() re-renders that paging/locale
// changes trigger; a stale/absent id falls back to the newest run.
const buyNextSelected = {};

// The round's Layer-B run history as a plain array, newest first — read
// defensively (matches history() in routes/recommendations.js) so legacy rounds
// with only the pre-#115 single round.recommendations object still render, with
// no migration. Returns [] when nothing has been generated.
function buyNextRuns(round) {
  if (Array.isArray(round.recommendationRuns)) return round.recommendationRuns;
  if (round.recommendations && Array.isArray(round.recommendations.items)) {
    return [{ id: 'legacy', ...round.recommendations }];
  }
  return [];
}

function renderBuyNext(round, activeGames, statsByGame) {
  const runs = buyNextRuns(round);
  // Nothing to offer on a near-empty round (unless a list was already generated).
  if (activeGames.length < 3 && !runs.length) return;

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
  if (runs.length) {
    // Which run of the history to show: the remembered one, else the newest.
    let idx = runs.findIndex((r) => r.id === buyNextSelected[round.id]);
    if (idx < 0) idx = 0;
    buyNextSelected[round.id] = runs[idx].id;
    const cached = runs[idx];
    const items = cached.items.slice(0, 8);
    // The list can be long and this is a "once in a while" feature, so collapse
    // it by default (issue #113). It starts expanded only on the single
    // re-render right after a generate / paging / delete (buyNextKeepOpen,
    // cleared on read); the header + regenerate button stay visible so the
    // feature stays discoverable. The header bar doubles as the collapse toggle.
    const startOpen = buyNextKeepOpen.has(round.id);
    buyNextKeepOpen.delete(round.id);
    const collapse = h(`<div class="buynext__collapse${startOpen ? ' is-open' : ''}">
         <div class="buynext__bar" role="button" tabindex="0" aria-expanded="${startOpen}">
           <span class="buynext__label">${esc(t('buynext.llmTitle'))}</span>
           <span class="buynext__baraside">
             <span class="muted buynext__count">${esc(t('buynext.llmCount', { n: items.length }))}</span>
             <i class="ti ti-chevron-down buynext__caret" aria-hidden="true"></i>
           </span>
         </div>
         <div class="buynext__body"${startOpen ? '' : ' hidden'}></div>
       </div>`);
    const body = collapse.querySelector('.buynext__body');
    const list = h('<div class="recommend-list"></div>');
    items.forEach(({ title, reason, platform, url }) => {
      // platform/url are absent on runs cached before #106 — degrade to the
      // plain title-and-reason row in that case.
      const badge = platform ? ` ${platformTag(platform)}` : '';
      const link = url
        ? `<a class="recommend-item__link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">
             <i class="ti ti-external-link" aria-hidden="true"></i> ${esc(t('buynext.view'))}</a>`
        : '';
      list.appendChild(h(`<div class="recommend-item">
           <div class="recommend-item__info">
             <span class="recommend-item__head">
               <span class="recommend-item__title">${esc(title)}</span>${badge}
             </span>
             ${reason ? `<span class="recommend-item__reason">${esc(reason)}</span>` : ''}
           </div>
           ${link}
         </div>`));
    });
    body.appendChild(list);
    body.appendChild(h(`<div class="muted buynext__meta">${esc(t('buynext.meta', {
      when: fmtDateTime(cached.generatedAt),
      model: cached.model || '',
    }))}</div>`));
    // History controls (#115): page through past runs (numbered oldest→newest,
    // so the newest shows n/n) and delete the shown run. Selecting a run keeps
    // the list open across the re-render (buyNextKeepOpen).
    const nav = h(`<div class="buynext__nav">
         <div class="buynext__pager">
           <button class="btn btn--sm buynext__page" data-dir="older" aria-label="${esc(t('buynext.olderRunAria'))}">
             <i class="ti ti-chevron-left" aria-hidden="true"></i> ${esc(t('buynext.olderRun'))}</button>
           <span class="muted buynext__pos">${esc(t('buynext.runPosition', { i: runs.length - idx, n: runs.length }))}</span>
           <button class="btn btn--sm buynext__page" data-dir="newer" aria-label="${esc(t('buynext.newerRunAria'))}">
             ${esc(t('buynext.newerRun'))} <i class="ti ti-chevron-right" aria-hidden="true"></i></button>
         </div>
         <button class="btn btn--sm btn--danger buynext__del"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('buynext.deleteRun'))}</button>
       </div>`);
    const older = nav.querySelector('[data-dir="older"]');
    const newer = nav.querySelector('[data-dir="newer"]');
    older.disabled = idx >= runs.length - 1; // no older run
    newer.disabled = idx <= 0; // no newer run
    const selectRun = (targetIdx) => {
      buyNextSelected[round.id] = runs[targetIdx].id;
      buyNextKeepOpen.add(round.id);
      showRound(round.id);
    };
    older.addEventListener('click', () => { if (!older.disabled) selectRun(idx + 1); });
    newer.addEventListener('click', () => { if (!newer.disabled) selectRun(idx - 1); });
    nav.querySelector('.buynext__del').addEventListener('click', () => deleteBuyNextRun(round, cached));
    body.appendChild(nav);
    const bar = collapse.querySelector('.buynext__bar');
    let expanded = startOpen;
    const toggle = () => {
      expanded = !expanded;
      body.hidden = !expanded;
      collapse.classList.toggle('is-open', expanded);
      bar.setAttribute('aria-expanded', String(expanded));
    };
    bar.addEventListener('click', toggle);
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    llm.appendChild(collapse);
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
    const rec = await api('POST', `/api/rounds/${round.id}/recommendations`, { locale: getLocale() });
    // The POST appends a new run; select and expand it on re-render (#113/#115).
    buyNextSelected[round.id] = rec.id;
    buyNextKeepOpen.add(round.id);
    showRound(round.id); // re-render the Start tab with the fresh run
  } catch (e) {
    const msg = e.message === 'not_configured' ? t('buynext.unavailable')
      : e.message === 'quota_recommendations' ? t('buynext.quota')
      : t('buynext.failed');
    toast(msg);
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// Delete one run from the Layer-B history (#115). After it's gone the selection
// falls back to the newest remaining run (or the empty state), kept expanded.
async function deleteBuyNextRun(round, run) {
  if (!confirm(t('buynext.deleteRunConfirm'))) return;
  try {
    await api('DELETE', `/api/rounds/${round.id}/recommendations/${run.id}`);
    delete buyNextSelected[round.id];
    buyNextKeepOpen.add(round.id);
    showRound(round.id);
  } catch {
    toast(t('buynext.deleteRunFailed'));
  }
}

