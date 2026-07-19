/* Spielwirbel – views: the round hub's non-Start tabs — Regal (games library),
   Chronik (session history), Pokale (trophies) and the retired-games screen.
   Loaded after views-round.js; shares one global script scope. */

// --- Regal tab: the games library — search, filter chips, cover grid.
function renderRegalTab(round, activeGames) {
  const rid = round.id;

  // Filters (and sort) persist for the session but are scoped to one round —
  // opening a different round's Regal resets them to defaults.
  if (regalFiltersRid !== round.id) {
    regalFilters = { type: 'all', durations: new Set(), tags: new Set(), query: '' };
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
    // Custom-tag chips (#238): one per round tag, all off by default; ON tags
    // combine with AND. Ids of since-deleted tags are pruned from the
    // persisted set so they can't invisibly filter everything out.
    const roundTags = round.tags || [];
    const tagFilter = regalFilters.tags;
    [...tagFilter].forEach((x) => { if (!roundTags.some((tg) => tg.id === x)) tagFilter.delete(x); });
    if (roundTags.length) {
      chips.appendChild(h('<span class="filter-chips__sep"></span>'));
      roundTags.forEach((tg) => {
        const chip = h(`<button class="chip${tagFilter.has(tg.id) ? ' is-on' : ''}"><i class="ti ti-tags" aria-hidden="true"></i>${esc(tg.name)}</button>`);
        chip.addEventListener('click', () => {
          if (tagFilter.has(tg.id)) tagFilter.delete(tg.id);
          else tagFilter.add(tg.id);
          chip.classList.toggle('is-on', tagFilter.has(tg.id));
          renderGames();
        });
        chips.appendChild(chip);
      });
    }
    gamesSec.appendChild(chips);

    // Build the cards once and remember them by game id. When re-sorting we only
    // reorder these existing nodes – no page rebuild that would reset the scroll.
    // Covers load lazily as cards scroll into view (#198); watch the card, not
    // the __img — the card's `content-visibility: auto` skips descendant layout.
    const loadCover = createCoverLoader();
    const cardById = {};
    activeGames.forEach((g) => {
      const fallback = g.image
        ? ''
        : `<i class="ti ${typeIcon(g.type)}" aria-hidden="true"></i>`;
      const avg = avgMap[g.id];
      const scorePill =
        avg !== null
          ? `<span class="score-pill" style="background:${avgColor(avg)}">Ø ${avg.toFixed(1)}</span>`
          : `<span class="score-pill score-pill--none">${esc(t('games.scoreNew'))}</span>`;
      const gc = h(`<div class="game-card game-card--clickable">
           <div class="game-card__img">${fallback}
             <div class="game-card__badges">${scorePill}${typeBadge(g.type)}${durationBadge(g.duration)}</div>
           </div>
           <div class="game-card__body">
             <div class="game-card__title">${esc(g.title)}</div>
           </div>
         </div>`);
      if (g.image) loadCover(gc, g.image, gc.querySelector('.game-card__img'));
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
      if (tagFilter.size && ![...tagFilter].every((x) => (g.tagIds || []).includes(x))) return false;
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

// --- Chronik tab: one timeline of sessions and shelf changes. The activity
// feed arrives as its own argument (fetched per visit by showRound, #197) —
// it is no longer part of the round payload.
function renderChronikTab(round, activities) {
  const rid = round.id;
  const loadCover = createCoverLoader(); // lazy session thumbs (#198)

  // Collect all entries: done sessions as cards, game activities as quiet rows.
  const entries = [];
  round.sessions
    .filter((s) => s.done)
    .forEach((s) => entries.push({ kind: 'session', at: s.createdAt, session: s }));
  (activities || []).forEach((a) => {
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
         <div class="session-card__img">${thumbIcon}</div>
         <div class="session-card__body">
           <div class="session-card__title">${title}${pill}</div>
           <div class="session-card__meta">${parts.join(' · ')}</div>
         </div>
       </button>`);
    if (chosen && chosen.image) loadCover(card.querySelector('.session-card__img'), chosen.image);
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
  try { round = await fetchRound(rid); }
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
    const loadCover = createCoverLoader(); // lazy archive thumbs (#198)
    games.forEach((g) => {
      const fallback = g.image
        ? ''
        : `<i class="ti ${typeIcon(g.type)}" aria-hidden="true"></i>`;
      const when = g.retiredAt ? fmtDateTime(g.retiredAt) : '?';
      const row = h(`<div class="archive-row">
           <div class="archive-row__img">${fallback}</div>
           <div class="archive-row__body">
             <div class="archive-row__title">${esc(g.title)} ${typeTag(g.type)} ${durationTag(g.duration)}</div>
             <div class="muted archive-row__meta"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('retired.at', { when }))}</div>
           </div>
           <div class="archive-row__actions">
             <button class="btn" data-act="restore"><i class="ti ti-arrow-back-up" aria-hidden="true"></i> ${esc(t('retired.restore'))}</button>
             <button class="btn btn--danger" data-act="delete"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('retired.delete'))}</button>
           </div>
         </div>`);
      if (g.image) loadCover(row.querySelector('.archive-row__img'), g.image);
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

