/* Spielwirbel – views: session setup, voting (hot-seat),
   finale reveal, results podium. Part of the frontend; all files share one
   global script scope. */

// =================== Session: setup ===================

function showStartSession(round) {
  currentView = () => showStartSession(round);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(round.id) },
    { label: t('startSession.crumb') },
  ]);
  app.innerHTML = '';
  app.appendChild(h(`<div class="page-head"><h1>${esc(t('startSession.title'))}</h1></div>`));

  const activeGames = round.games.filter((g) => !g.retired);

  const form = h(`<div>
      <div class="field">
        <label>${esc(t('startSession.membersLabel'))}</label>
        <div id="seatMount"></div>
        <div class="muted field__hint center">${esc(t('startSession.membersNote'))}</div>
      </div>
      <div class="field" id="gamesFilterField" hidden>
        <label>${esc(t('startSession.whichGames'))}</label>
        <div class="filter-chips" id="filterChips"></div>
      </div>
      <div class="field">
        <label for="count">${esc(t('startSession.countLabel'))}</label>
        <div class="stepper">
          <button type="button" class="stepper__btn" data-d="-1" aria-label="−"><i class="ti ti-minus" aria-hidden="true"></i></button>
          <input id="count" class="stepper__val" inputmode="numeric" value="3" />
          <button type="button" class="stepper__btn" data-d="1" aria-label="+"><i class="ti ti-plus" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="pool-hint" id="poolHint"></div>
      <div class="toolbar">
        <button id="go" class="btn btn--primary btn--lg"><i class="ti ti-tornado" aria-hidden="true"></i> ${esc(t('startSession.draw'))}</button>
      </div>
    </div>`);
  app.appendChild(form);

  // Custom-tag filter (#238, tri-state #241): all ignored by default = no tag
  // filter. Map<tagId, 'include'|'exclude'>; included tags combine with AND,
  // excluded tags reject a game carrying any of them.
  // Preset from the round's last draw-flow session (#252) when there is one;
  // tag ids whose tag has since been deleted are dropped, mirroring the
  // drop-unknown-ids rule the backend applies at session-creation time.
  const preset = round.lastSessionFilters || null;
  const selectedTags = new Map();
  if (preset) {
    const known = new Set((round.tags || []).map((tg) => tg.id));
    (preset.tagIds || []).filter((x) => known.has(x)).forEach((x) => selectedTags.set(x, 'include'));
    (preset.excludeTagIds || [])
      .filter((x) => known.has(x) && !selectedTags.has(x))
      .forEach((x) => selectedTags.set(x, 'exclude'));
  }
  // All members join by default; the number of joining members filters the
  // games by their player count.
  const joining = new Set(round.members.map((m) => m.id));

  // Games matching the tag filter, whose player range fits the joining count.
  const pool = () =>
    activeGames.filter(
      (g) =>
        matchesTagFilter(selectedTags, g.tagIds) &&
        (typeof g.minPlayers !== 'number' || joining.size >= g.minPlayers) &&
        (typeof g.maxPlayers !== 'number' || joining.size <= g.maxPlayers)
    );

  // Live pool preview: count plus a few cover thumbnails.
  const hint = form.querySelector('#poolHint');
  const updateHint = () => {
    const games = pool();
    const thumbs = games
      .slice(0, 6)
      .map((g) => {
        const style = g.image ? ` style="background-image:url('${g.image}')"` : '';
        const fb = coverPlaceholder(g);
        return `<span class="pool-thumb"${style} title="${esc(g.title)}">${fb}</span>`;
      })
      .join('');
    const more = games.length > 6 ? `<span class="pool-thumb pool-thumb--more">+${games.length - 6}</span>` : '';
    hint.innerHTML = `<span class="pool-hint__text">${esc(
      tn(games.length, 'startSession.availableOne', 'startSession.available')
    )}</span><span class="pool-thumbs">${thumbs}${more}</span>`;
  };
  // Seats around the table: tap a member to toggle whether they join tonight.
  form.querySelector('#seatMount').replaceWith(renderSeatPicker(round, joining, updateHint));
  updateHint();

  // Custom-tag chips (#238, tri-state #241) are the only game filter now (#242).
  // Clicking cycles ignore -> include -> exclude -> ignore. With no round tags
  // there is nothing to filter, so the whole field stays hidden.
  const chips = form.querySelector('#filterChips');
  const roundTags = round.tags || [];
  if (roundTags.length) {
    form.querySelector('#gamesFilterField').hidden = false;
    roundTags.forEach((tg) => {
      const chip = h('<button type="button" class="chip"></button>');
      paintTagChip(chip, tg.name, selectedTags.get(tg.id));
      chip.addEventListener('click', () => {
        paintTagChip(chip, tg.name, cycleTagState(selectedTags, tg.id));
        updateHint();
      });
      chips.appendChild(chip);
    });
  }

  const countInput = form.querySelector('#count');
  // Preloaded from the remembered preset (#252); the markup's 3 stays the
  // default for a round that has never run a draw-flow session.
  if (preset && Number.isInteger(preset.count) && preset.count >= 1) {
    countInput.value = String(preset.count);
  }
  countInput.addEventListener('input', () => {
    const digits = countInput.value.replace(/\D/g, '');
    if (countInput.value !== digits) countInput.value = digits;
  });
  form.querySelectorAll('.stepper__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cur = parseInt(countInput.value, 10);
      countInput.value = Math.max(1, (Number.isInteger(cur) ? cur : 1) + parseInt(btn.dataset.d, 10));
    });
  });

  form.querySelector('#go').addEventListener('click', async () => {
    let count = parseInt(countInput.value, 10);
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (joining.size === 0) return toast(t('startSession.toast.noMembers'));
    if (pool().length === 0) return toast(t('startSession.toast.noGames'));
    try {
      const data = await api('POST', `/api/rounds/${round.id}/sessions`, {
        count,
        tagIds: [...selectedTags].filter(([, s]) => s === 'include').map(([id]) => id),
        excludeTagIds: [...selectedTags].filter(([, s]) => s === 'exclude').map(([id]) => id),
        memberIds: [...joining],
      });
      // Straight into the first handover — the drawn games stay secret until
      // each person rates them.
      startVoting(round, data.session, data.games, data.members);
    } catch (e) { toast(e.message); }
  });
}

// =================== Voting (hot-seat) ===================

function startVoting(round, session, games, members) {
  const setVotingCrumbs = () => setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(round.id) },
    { label: t('vote.crumb') },
  ]);
  setVotingCrumbs();

  // votes[memberId][gameId] = { rating, retire }
  const votes = {};
  members.forEach((m) => (votes[m.id] = {}));

  // Members in random order; a "you're up" screen before each person.
  const order = shuffled(members);
  const steps = [];
  order.forEach((m) => {
    steps.push({ type: 'intro', member: m });
    games.forEach((g) => steps.push({ type: 'vote', member: m, game: g }));
  });

  let idx = 0;
  // Re-render the current step in the new language (keeps votes/progress).
  // Also refresh the breadcrumb so its label follows the new locale.
  currentView = () => { setVotingCrumbs(); render(); };

  // Segmented progress: one segment per member, filled in their color.
  const perMember = games.length + 1; // intro + one card per game
  function progressBar() {
    return `<div class="vote-progress">${order
      .map((m, mi) => {
        const done = Math.max(0, Math.min(perMember, idx - mi * perMember));
        const pct = Math.round((done / perMember) * 100);
        return `<span class="vote-progress__seg"><span style="width:${pct}%;background:${memberColor(round, m.id)}"></span></span>`;
      })
      .join('')}</div>`;
  }

  function render() {
    const step = steps[idx];
    const total = steps.length;

    // Handover screen: full color card in the member's color.
    if (step.type === 'intro') {
      const color = memberColor(round, step.member.id);
      app.innerHTML = '';
      const card = h(`<div class="handover" style="background:${color}">
          ${progressBar()}
          <span class="handover__avatar" style="color:${color}">${esc(initials(step.member.name))}</span>
          <div class="handover__name">${esc(t('vote.turn', { name: step.member.name }))}</div>
          <div class="handover__sub"><i class="ti ti-eye-off" aria-hidden="true"></i> ${esc(t('vote.handoverSub'))}</div>
          <button class="handover__go" id="goBtn" style="color:${color}">${esc(t('vote.go'))}</button>
          ${idx > 0 ? `<button class="handover__back" id="backBtn"><i class="ti ti-chevron-left" aria-hidden="true"></i> ${esc(t('vote.back'))}</button>` : ''}
        </div>`);
      card.querySelector('#goBtn').addEventListener('click', () => { idx++; render(); });
      const back = card.querySelector('#backBtn');
      if (back) back.addEventListener('click', () => { idx--; render(); });
      app.appendChild(card);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const { member, game } = step;
    const current = votes[member.id][game.id] || { rating: null, retire: false };
    const color = memberColor(round, member.id);

    const imgStyle = game.image ? `style="background-image:url('${game.image}')"` : '';
    const fallback = coverPlaceholder(game);

    app.innerHTML = '';
    const card = h(`<div class="vote vote--split">
        ${progressBar()}
        <div class="vote__who">${esc(t('vote.who'))} <strong style="color:${color}">${esc(member.name)}</strong></div>
        <div class="vote__img" ${imgStyle}>${fallback}</div>
        <div class="vote__title">${esc(game.title)}</div>
        <div class="vote__q">${esc(t('vote.question'))}</div>
        <div class="rating"></div>
        <div class="rating-scale"><span>${esc(t('vote.scaleLow'))}</span><span>${esc(t('vote.scaleHigh'))}</span></div>
        <div class="vote__sort">
          <button class="sortBtn ${current.retire ? 'is-selected' : ''}"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('vote.suggestRetire'))}</button>
        </div>
        <div class="vote__nav">
          <button class="btn" id="backBtn"><i class="ti ti-chevron-left" aria-hidden="true"></i> ${esc(t('vote.back'))}</button>
          <button class="btn btn--primary" id="nextBtn">${idx === total - 1 ? esc(t('vote.finish')) + ' <i class="ti ti-chevron-right" aria-hidden="true"></i>' : esc(t('vote.next'))}</button>
        </div>
      </div>`);

    // 1–5 as mood faces; the selected one takes the rating's traffic-light color.
    const MOODS = ['ti-mood-cry', 'ti-mood-sad', 'ti-mood-neutral', 'ti-mood-smile', 'ti-mood-crazy-happy'];
    const ratingEl = card.querySelector('.rating');
    for (let n = 1; n <= 5; n++) {
      const sel = current.rating === n;
      const b = h(`<button class="mood${sel ? ' is-selected' : ''}" aria-label="${n}">
           <i class="ti ${MOODS[n - 1]}" aria-hidden="true"></i><span class="mood__n">${n}</span>
         </button>`);
      if (sel) {
        b.style.background = avgColor(n);
        b.style.borderColor = avgColor(n);
      }
      b.addEventListener('click', () => {
        votes[member.id][game.id] = { rating: n, retire: current.retire };
        render();
      });
      ratingEl.appendChild(b);
    }

    const sortBtn = card.querySelector('.sortBtn');
    sortBtn.addEventListener('click', () => {
      votes[member.id][game.id] = { rating: current.rating, retire: !current.retire };
      render();
    });

    const backBtn = card.querySelector('#backBtn');
    backBtn.disabled = idx === 0;
    backBtn.addEventListener('click', () => { idx--; render(); });

    card.querySelector('#nextBtn').addEventListener('click', () => {
      const v = votes[member.id][game.id];
      if (!v || (v.rating === null && !v.retire)) {
        return toast(t('vote.toast.needRating'));
      }
      if (idx === total - 1) finish();
      else { idx++; render(); }
    });

    app.appendChild(card);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function finish() {
    try {
      await api('POST', `/api/rounds/${round.id}/sessions/${session.id}/results`, { votes });
      const fresh = await api('GET', '/api/rounds/' + round.id);
      const savedSession = fresh.sessions.find((s) => s.id === session.id);
      // Nobody sees the result yet: the finale gate gathers everyone first.
      showFinale(fresh, savedSession, games);
    } catch (e) { toast(e.message); }
  }

  render();
}

// =================== Finale: everyone gathers for the reveal ===================

// Shown only when arriving from voting; opening old results from the Chronik
// skips the gate.
function showFinale(round, session, games) {
  currentView = () => showFinale(round, session, games);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(round.id) },
    { label: t('finale.crumb') },
  ]);

  const voters = Array.isArray(session.memberIds)
    ? round.members.filter((m) => session.memberIds.includes(m.id))
    : round.members;

  app.innerHTML = '';
  const stage = h(`<div class="stage">
      <div class="stage__seal">
        <i class="ti ti-mail" aria-hidden="true"></i>
        <span class="stage__lock"><i class="ti ti-lock" aria-hidden="true"></i></span>
      </div>
      <h1 class="stage__title">${esc(t('finale.title'))}</h1>
      <div class="stage__sub">${esc(t('finale.sub'))}</div>
      <div class="stage__voters">${voters
        .map(
          (m) => `<span class="stage__voter">
             <span class="stage__voter-avatar">
               <span class="avatar" style="background:${memberColor(round, m.id)}">${esc(initials(m.name))}</span>
               <span class="stage__voter-check"><i class="ti ti-check" aria-hidden="true"></i></span>
             </span>
             <span class="stage__voter-name">${esc(m.name)}</span>
           </span>`
        )
        .join('')}</div>
      <button class="btn btn--primary btn--lg stage__reveal"><i class="ti ti-sparkles" aria-hidden="true"></i> ${esc(t('finale.reveal'))}</button>
      <div class="stage__note">${esc(t('finale.note'))}</div>
    </div>`);
  stage.querySelector('.stage__reveal').addEventListener('click', () => showResults(round, session, games, true));
  app.appendChild(stage);
  window.scrollTo(0, 0);
}

// =================== Results ===================

async function showResults(round, session, gamesHint, reveal) {
  currentView = () => showResults(round, session, gamesHint);
  syncUrl(`/round/${round.id}/session/${session.id}`);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(round.id) },
    { label: t('result.crumb') },
  ]);

  // Resolve the session's game objects.
  const games = session.gameIds
    .map((gid) => round.games.find((g) => g.id === gid) || (gamesHint || []).find((g) => g.id === gid))
    .filter(Boolean);
  // Only the members who joined the session (older sessions have no list, so
  // fall back to all members of the round).
  const members = Array.isArray(session.memberIds)
    ? round.members.filter((m) => session.memberIds.includes(m.id))
    : round.members;

  // Tally per game.
  const rows = games.map((g) => {
    const ratings = [];
    let sortCount = 0;
    members.forEach((m) => {
      const v = (session.votes[m.id] || {})[g.id];
      if (!v) return;
      if (v.retire) sortCount++;
      if (typeof v.rating === 'number') ratings.push(v.rating);
    });
    const sum = ratings.reduce((a, b) => a + b, 0);
    const avg = ratings.length ? sum / ratings.length : 0;
    const dist = [0, 0, 0, 0, 0];
    ratings.forEach((r) => dist[r - 1]++);
    return { game: g, avg, count: ratings.length, sortCount, dist };
  });

  rows.sort((a, b) => b.avg - a.avg);
  // Tie-aware places ("1, 2, 2, 4"): games with the same displayed average share
  // a place, medal, and pedestal. Drives both the podium and the medal list.
  computePlaces(rows).forEach((place, i) => { rows[i].place = place; });

  app.innerHTML = '';
  const when = fmtDateTime(session.createdAt);
  const head = h(`<div class="page-head"><div>
         <h1 class="result-title">${esc(t('result.title'))}</h1>
         <div class="muted">${esc(t('result.subtitle', { when, n: games.length }))}</div>
       </div></div>`);
  app.appendChild(head);
  const titleEl = head.querySelector('.result-title');

  // Who joined this session — the members whose votes make up the result.
  if (members.length) {
    const people = h(`<div class="result-people">
         <span class="result-people__label">${esc(t('result.participants'))}</span>
         <span class="result-people__list">${members
           .map(
             (m) => `<span class="result-people__person" data-mid="${esc(m.id)}">
                <span class="avatar" style="background:${memberColor(round, m.id)}">${esc(initials(m.name))}</span>
                <span class="result-people__name">${esc(m.name)}</span>
              </span>`
           )
           .join('')}</span>
       </div>`);
    // Each participant opens that member's detail page.
    people.querySelectorAll('.result-people__person[data-mid]').forEach((el) => {
      makeMemberLink(el, round.id, el.dataset.mid);
    });
    app.appendChild(people);
  }

  // Podium: the top three *places* as a stage. Tied games share a place, so a
  // 3-way tie for 1st shows all three (all crowned, same height). Arranged as
  // [place 2 | place 1 | place 3] so a lone winner stays centered as before.
  // With `reveal` the pedestals rise (shortest first) and confetti falls — the
  // finale's payoff moment.
  const podiumRows = rows.filter((r) => r.place && r.place <= 3);
  if (rows.length >= 2 && podiumRows.length && !session.cancelled) {
    const atPlace = (p) => podiumRows.filter((r) => r.place === p);
    const arranged = [...atPlace(2), ...atPlace(1), ...atPlace(3)];
    const podium = h(`<div class="result-podium${reveal ? ' is-reveal' : ''}"></div>`);
    arranged.forEach((r) => {
      const place = r.place;
      const g = r.game;
      const imgStyle = g.image ? ` style="background-image:url('${g.image}')"` : '';
      const fb = coverPlaceholder(g);
      const col = h(`<div class="result-podium__col result-podium__col--${place}">
             ${place === 1 ? '<i class="ti ti-crown result-podium__crown" aria-hidden="true"></i>' : ''}
             <span class="result-podium__img"${imgStyle}>${fb}</span>
             <span class="result-podium__title">${esc(g.title)}</span>
             <span class="score-pill result-podium__pill" style="background:${avgColor(r.avg)}">Ø ${r.avg.toFixed(1)}</span>
             <span class="result-podium__base">${place}</span>
           </div>`);
      makeGameLink(col, round.id, g.id);
      podium.appendChild(col);
    });
    if (reveal) {
      const conf = h('<div class="confetti" aria-hidden="true"></div>');
      for (let i = 0; i < 16; i++) {
        const bit = h('<span class="confetti__bit"></span>');
        bit.style.left = Math.round(Math.random() * 100) + '%';
        bit.style.background = MEMBER_COLORS[i % MEMBER_COLORS.length];
        bit.style.animationDelay = (Math.random() * 0.9).toFixed(2) + 's';
        conf.appendChild(bit);
      }
      podium.appendChild(conf);
    }
    app.appendChild(podium);
  }

  function updateTitle() {
    if (cancelled) {
      titleEl.textContent = t('result.titleCancelled');
    } else if (finished && chosenId) {
      const g = games.find((x) => x.id === chosenId);
      const gname = g ? g.title : '';
      const names = winnerIds
        .map((wid) => (members.find((m) => m.id === wid) || {}).name)
        .filter(Boolean);
      if (names.length === 0) {
        titleEl.textContent = t('result.titlePlayed', { game: gname });
      } else {
        titleEl.textContent = t(names.length === 1 ? 'result.titleWonOne' : 'result.titleWonMany', {
          game: gname,
          names: joinNames(names),
        });
      }
    } else {
      titleEl.textContent = t('result.title');
    }
  }

  // Banner: shows which game is being played (or prompts to choose).
  let chosenId = session.chosenGameId || null;
  const banner = h('<div class="chosen-banner"></div>');
  app.appendChild(banner);

  // Cancel session (the alternative to choosing a game; see renderCancel).
  const cancelWrap = h('<div class="cancel-area"></div>');
  app.appendChild(cancelWrap);

  const medalRanks = ['gold', 'silver', 'bronze'];
  const maxBar = Math.max(1, ...rows.map((r) => Math.max(...r.dist)));
  const rowRefs = [];

  rows.forEach((r) => {
    const g = r.game;
    const imgStyle = g.image ? `style="background-image:url('${g.image}')"` : '';
    const fallback = coverPlaceholder(g);
    const bars = r.dist
      .map((c, n) => {
        const hpx = 4 + Math.round((c / maxBar) * 24);
        return `<div class="bar" style="height:${hpx}px" title="${esc(t('result.barTitle', { c, r: n + 1 }))}">${c || ''}</div>`;
      })
      .join('');
    // Info if the game has been retired in the meantime.
    const retiredBadge = g.retired ? ` <span class="tag tag--retired">${iconText('ti-trash', t('result.retiredTag'))}</span>` : '';
    // "Suggested for retirement" line; with a direct action if not retired yet.
    const sortFlag = r.sortCount
      ? `<div class="sort-flag"><i class="ti ti-trash" aria-hidden="true"></i> ${esc(t('result.sortFlag', { n: r.sortCount }))}${
          g.retired ? '' : ` <button class="link-btn sortflag-btn">${esc(t('result.retireNow'))}</button>`
        }</div>`
      : '';
    const medal = r.place && r.place <= 3 ? `<span class="rank-medal rank-medal--${medalRanks[r.place - 1]}"><i class="ti ti-medal" aria-hidden="true"></i></span>` : '';
    const row = h(`<div class="result-row">
         <div class="result-row__img" ${imgStyle}>${fallback}</div>
         <div>
           <div class="result-row__title">${medal}${esc(g.title)}${retiredBadge}</div>
           <div class="result-row__bars">${bars}</div>
           ${sortFlag}
           <button class="link-btn result-row__remove">${iconText('ti-trash', t('result.removeGame'))}</button>
         </div>
         <div class="result-row__score">
           <div class="score-big">${r.count ? r.avg.toFixed(1) : '–'}</div>
           <div class="score-label">${esc(t('result.avgOf', { n: r.count }))}</div>
           <button class="btn play-btn">${iconText('ti-player-play', t('result.play'))}</button>
         </div>
         <div class="row-finish" hidden></div>
       </div>`);
    // Title and cover open the game's detail page (the action buttons below
    // live in sibling elements, so they keep working independently).
    makeGameLink(row.querySelector('.result-row__title'), round.id, g.id);
    makeGameLink(row.querySelector('.result-row__img'), round.id, g.id);
    const sortBtn = row.querySelector('.sortflag-btn');
    if (sortBtn) {
      sortBtn.addEventListener('click', async () => {
        if (!confirm(t('result.retireNowConfirm', { title: g.title }))) return;
        try {
          await api('POST', `/api/rounds/${round.id}/games/${g.id}/retire`, { retired: true });
          toast(t('games.retired', { title: g.title }));
          const fresh = await api('GET', '/api/rounds/' + round.id);
          const sess = fresh.sessions.find((s) => s.id === session.id) || session;
          showResults(fresh, sess, games);
        } catch (e) { toast(e.message); }
      });
    }
    const removeBtn = row.querySelector('.result-row__remove');
    removeBtn.addEventListener('click', async () => {
      if (!confirm(t('result.removeGameConfirm', { title: g.title }))) return;
      try {
        await api('DELETE', `/api/rounds/${round.id}/sessions/${session.id}/games/${g.id}`);
        toast(t('result.toast.gameRemoved', { title: g.title }));
        const fresh = await api('GET', '/api/rounds/' + round.id);
        const sess = fresh.sessions.find((s) => s.id === session.id) || session;
        showResults(fresh, sess, games);
      } catch (e) { toast(e.message); }
    });
    const btn = row.querySelector('.play-btn');
    btn.addEventListener('click', async () => {
      const newId = chosenId === g.id ? null : g.id; // tapping again clears it
      try {
        await api('POST', `/api/rounds/${round.id}/sessions/${session.id}/choice`, { gameId: newId });
        chosenId = newId;
        session.chosenGameId = newId;
        updateChosen();
        toast(newId ? t('result.toast.willPlay', { title: g.title }) : t('result.toast.choiceCleared'));
      } catch (e) { toast(e.message); }
    });
    rowRefs.push({ gameId: g.id, row, btn, finishEl: row.querySelector('.row-finish') });
    app.appendChild(row);
  });

  function updateChosen() {
    rowRefs.forEach(({ gameId, row, btn }) => {
      const isChosen = gameId === chosenId;
      row.classList.toggle('is-chosen', isChosen);
      btn.classList.toggle('btn--primary', isChosen);
      btn.innerHTML = isChosen
        ? iconText('ti-check', t('result.willPlay'))
        : iconText('ti-player-play', t('result.play'));
      // Once the result is recorded or the session cancelled, the choice can
      // no longer be changed.
      btn.disabled = finished || cancelled;
      btn.title = finished ? t('result.lockedHint') : cancelled ? t('result.cancelledHint') : '';
    });
    banner.classList.toggle('is-cancelled', cancelled);
    if (cancelled) {
      banner.innerHTML = iconText('ti-x', t('result.bannerCancelled'));
      banner.classList.remove('is-set');
    } else if (chosenId) {
      const g = games.find((x) => x.id === chosenId);
      const icon = `<i class="ti ${GAME_ICON}" aria-hidden="true"></i> `;
      banner.innerHTML = icon + t('result.bannerChosen', { title: '<strong>' + esc(g ? g.title : '') + '</strong>' });
      banner.classList.add('is-set');
    } else {
      banner.textContent = t('result.bannerPrompt');
      banner.classList.remove('is-set');
    }
    renderCancel();
    renderFinish();
  }

  // --- Finish game / record winners (rendered inside the chosen game's tile) ---
  let finished = !!session.finished;
  let cancelled = !!session.cancelled;
  let winnerIds = Array.isArray(session.winnerIds) ? session.winnerIds.slice() : [];

  // Cancel is the alternative final state: only offered while no game is
  // chosen, and undoable like the finish reset.
  function renderCancel() {
    cancelWrap.innerHTML = '';
    if (finished || chosenId) return;
    if (cancelled) {
      const undo = h(`<button class="btn btn--ghost">${esc(t('result.cancelUndo'))}</button>`);
      undo.addEventListener('click', async () => {
        try {
          await api('POST', `/api/rounds/${round.id}/sessions/${session.id}/cancel`, { cancelled: false });
          cancelled = false;
          session.cancelled = false;
          session.cancelledAt = null;
          toast(t('result.toast.cancelUndone'));
          updateChosen();
        } catch (e) { toast(e.message); }
      });
      cancelWrap.appendChild(undo);
    } else {
      const btn = h(`<button class="btn btn--ghost">${iconText('ti-x', t('result.cancel'))}</button>`);
      btn.addEventListener('click', async () => {
        if (!confirm(t('result.cancelConfirm'))) return;
        try {
          await api('POST', `/api/rounds/${round.id}/sessions/${session.id}/cancel`, { cancelled: true });
          cancelled = true;
          session.cancelled = true;
          toast(t('result.toast.cancelled'));
          updateChosen();
        } catch (e) { toast(e.message); }
      });
      cancelWrap.appendChild(btn);
    }
  }

  function renderFinish() {
    updateTitle();
    rowRefs.forEach(({ finishEl }) => { finishEl.hidden = true; finishEl.innerHTML = ''; });
    if (!chosenId) return;
    const ref = rowRefs.find((x) => x.gameId === chosenId);
    if (!ref) return;
    const finishWrap = ref.finishEl;
    finishWrap.hidden = false;
    const chosenGame = games.find((g) => g.id === chosenId);
    finishWrap.appendChild(
      h(`<h3>${finished ? iconText('ti-trophy', t('result.finishTitleDone')) : esc(t('result.finishTitle'))}</h3>`)
    );
    // Finishing comes first and needs no winners; the winner picker only shows
    // up afterwards, so it can't read as a prerequisite (#254).
    if (!finished) {
      finishWrap.appendChild(
        h(`<div class="muted" style="margin-bottom:10px">${esc(t('result.finishPrompt', { game: chosenGame ? chosenGame.title : '' }))}</div>`)
      );
      const finishBtn = h(`<button class="btn btn--primary">${iconText('ti-check', t('result.markPlayed'))}</button>`);
      finishBtn.addEventListener('click', () => saveWinners([]));
      const actions = h('<div class="toolbar" style="margin-top:14px"></div>');
      actions.appendChild(finishBtn);
      finishWrap.appendChild(actions);
      return;
    }

    finishWrap.appendChild(
      h(`<div class="muted" style="margin-bottom:10px">${esc(t('result.whoWon', { game: chosenGame ? chosenGame.title : '' }))}</div>`)
    );

    const chips = h('<div class="winner-chips"></div>');
    members.forEach((m) => {
      const sel = winnerIds.includes(m.id);
      const chip = h(`<button class="winner-chip ${sel ? 'is-selected' : ''}">${sel ? '<i class="ti ti-trophy" aria-hidden="true"></i> ' : ''}${esc(m.name)}</button>`);
      // Each toggle persists right away — no separate save button in this state.
      chip.addEventListener('click', () => saveWinners(
        winnerIds.includes(m.id) ? winnerIds.filter((x) => x !== m.id) : [...winnerIds, m.id]
      ));
      chips.appendChild(chip);
    });
    finishWrap.appendChild(chips);

    const actions = h('<div class="toolbar" style="margin-top:14px"></div>');
    const resetBtn = h(`<button class="btn btn--ghost">${esc(t('result.reset'))}</button>`);
    resetBtn.addEventListener('click', async () => {
      try {
        await api('POST', `/api/rounds/${round.id}/sessions/${session.id}/finish`, {
          finished: false,
          winnerIds: [],
        });
        finished = false;
        winnerIds = [];
        session.finished = false;
        session.winnerIds = [];
        toast(t('result.toast.reset'));
        renderFinish();
      } catch (e) { toast(e.message); }
    });
    actions.appendChild(resetBtn);
    finishWrap.appendChild(actions);

    const names = winnerIds
      .map((wid) => (members.find((m) => m.id === wid) || {}).name)
      .filter(Boolean);
    const inner = names.length
      ? iconText('ti-trophy', t('result.winners', { names: names.join(', ') }))
      : iconText('ti-check', t('result.playedNoWinner'));
    finishWrap.appendChild(h(`<div class="winner-result">${inner}</div>`));
  }

  // Marks the session finished with the given winners (possibly none) and
  // re-renders; only committed to local state once the server accepted it.
  async function saveWinners(ids) {
    try {
      const saved = await api('POST', `/api/rounds/${round.id}/sessions/${session.id}/finish`, {
        finished: true,
        winnerIds: ids,
      });
      finished = true;
      winnerIds = saved.winnerIds.slice(); // filtered server-side
      session.finished = true;
      session.winnerIds = winnerIds.slice();
      toast(t('result.toast.saved'));
      renderFinish();
    } catch (e) { toast(e.message); }
  }

  updateChosen();

  const back = h(`<div class="section center"><button class="btn btn--lg">${esc(t('common.back'))}</button></div>`);
  back.querySelector('button').addEventListener('click', () => navBack(() => showRound(round.id)));
  app.appendChild(back);

  // Delete session (subtle, at the bottom – like deleting a round)
  const del = h(`<div class="section center"><button class="link-btn" style="color:var(--danger)">${esc(t('result.deleteSession'))}</button></div>`);
  del.querySelector('button').addEventListener('click', async () => {
    if (!confirm(t('sessions.deleteConfirm', { when }))) return;
    try {
      await api('DELETE', `/api/rounds/${round.id}/sessions/${session.id}`);
      toast(t('sessions.deleted'));
      showRound(round.id);
    } catch (e) { toast(e.message); }
  });
  app.appendChild(del);

  // The most relevant info (chosen game, results) is at the top.
  window.scrollTo(0, 0);
}
