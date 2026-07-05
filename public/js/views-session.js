/* Familien-Spielesammlung – views: start session, voting (hot-seat), results.
   Part of the frontend; all files share one global script scope. */

// =================== Start session ===================

function showStartSession(round) {
  currentView = () => showStartSession(round);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(round.id) },
    { label: t('startSession.crumb') },
  ]);
  app.innerHTML = '';
  app.appendChild(h(`<div class="page-head"><h1>${esc(t('startSession.title'))}</h1></div>`));

  const counts = {
    all: round.games.filter((g) => !g.retired).length,
    digital: round.games.filter((g) => !g.retired && g.type === 'digital').length,
    analog: round.games.filter((g) => !g.retired && g.type === 'analog').length,
  };
  const DURATIONS = ['short', 'medium', 'long'];

  const form = h(`<div>
      <div class="field">
        <label>${esc(t('startSession.whichGames'))}</label>
        <div class="segmented" id="filterSeg">
          <label class="is-checked" data-f="all">${esc(t('startSession.filterAll', { n: counts.all }))}</label>
          <label data-f="analog">${esc(t('startSession.filterAnalog', { n: counts.analog }))}</label>
          <label data-f="digital">${esc(t('startSession.filterDigital', { n: counts.digital }))}</label>
        </div>
      </div>
      <div class="field">
        <label>${esc(t('startSession.durationLabel'))}</label>
        <div class="segmented" id="durationSeg">
          ${DURATIONS.map((d) => `<label class="is-checked" data-d="${d}">${t('duration.' + d)}</label>`).join('')}
        </div>
        <div class="muted" style="margin-top:6px;font-size:14px">${esc(t('startSession.durationNote'))}</div>
      </div>
      <div class="field">
        <label for="count">${esc(t('startSession.countLabel'))}</label>
        <input id="count" class="input" type="number" min="1" value="3" />
        <div class="muted" id="poolHint" style="margin-top:6px"></div>
      </div>
      <div class="toolbar">
        <button id="go" class="btn btn--primary btn--lg">${esc(t('startSession.draw'))}</button>
      </div>
    </div>`);
  app.appendChild(form);

  let filter = 'all';
  // All durations selected by default = no duration filter.
  const durations = new Set(DURATIONS);
  const seg = form.querySelector('#filterSeg');
  const durSeg = form.querySelector('#durationSeg');
  const countInput = form.querySelector('#count');
  const hint = form.querySelector('#poolHint');
  // Games matching both filters; with all durations selected, games without a
  // duration (from before the feature) are included too.
  const poolCount = () =>
    round.games.filter(
      (g) =>
        !g.retired &&
        (filter === 'all' || g.type === filter) &&
        (durations.size === DURATIONS.length || durations.has(g.duration))
    ).length;
  const updateHint = () => {
    hint.textContent = t('startSession.available', { n: poolCount() });
  };
  updateHint();
  seg.querySelectorAll('label').forEach((lbl) => {
    lbl.addEventListener('click', () => {
      seg.querySelectorAll('label').forEach((l) => l.classList.remove('is-checked'));
      lbl.classList.add('is-checked');
      filter = lbl.dataset.f;
      updateHint();
    });
  });
  // Multi-select: each duration toggles independently.
  durSeg.querySelectorAll('label').forEach((lbl) => {
    lbl.addEventListener('click', () => {
      const d = lbl.dataset.d;
      if (durations.has(d)) durations.delete(d);
      else durations.add(d);
      lbl.classList.toggle('is-checked', durations.has(d));
      updateHint();
    });
  });

  form.querySelector('#go').addEventListener('click', async () => {
    let count = parseInt(countInput.value, 10);
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (durations.size === 0 || poolCount() === 0) return toast(t('startSession.toast.noGames'));
    try {
      const data = await api('POST', `/api/rounds/${round.id}/sessions`, {
        count,
        filter,
        durations: [...durations],
      });
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

  function render() {
    const step = steps[idx];
    const total = steps.length;
    const pct = Math.round((idx / total) * 100);

    // Handover screen: pass the device to the next person.
    if (step.type === 'intro') {
      app.innerHTML = '';
      const card = h(`<div class="vote">
          <div class="vote__progress"><div style="width:${pct}%"></div></div>
          <div class="handover">
            <div class="handover__icon">🎲</div>
            <div class="handover__name">${esc(step.member.name)}</div>
            <div class="handover__sub">${esc(t('vote.handover'))}</div>
            <button class="btn btn--primary btn--lg" id="goBtn">${esc(t('vote.go'))}</button>
          </div>
          ${idx > 0 ? `<div class="vote__nav"><button class="btn" id="backBtn">${esc(t('vote.back'))}</button></div>` : ''}
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

    const imgStyle = game.image ? `style="background-image:url('${game.image}')"` : '';
    const fallback = game.image ? '' : (game.type === 'digital' ? '💻' : '🎲');

    app.innerHTML = '';
    const card = h(`<div class="vote vote--split">
        <div class="vote__progress"><div style="width:${pct}%"></div></div>
        <div class="vote__who">${esc(t('vote.who'))}<strong>${esc(member.name)}</strong></div>
        <div class="vote__img" ${imgStyle}>${fallback}</div>
        <div class="vote__title">${esc(game.title)}</div>
        <div class="vote__type">${typeTag(game.type)} ${durationTag(game.duration)}</div>
        <div class="vote__q">${esc(t('vote.question'))}</div>
        <div class="rating"></div>
        <div class="rating-scale"><span>${esc(t('vote.scaleLow'))}</span><span>${esc(t('vote.scaleHigh'))}</span></div>
        <div class="vote__sort">
          <button class="sortBtn ${current.retire ? 'is-selected' : ''}">${esc(t('vote.suggestRetire'))}</button>
        </div>
        <div class="vote__nav">
          <button class="btn" id="backBtn">${esc(t('vote.back'))}</button>
          <button class="btn btn--primary" id="nextBtn">${esc(idx === total - 1 ? t('vote.finish') : t('vote.next'))}</button>
        </div>
      </div>`);

    const ratingEl = card.querySelector('.rating');
    for (let n = 1; n <= 5; n++) {
      const b = h(`<button class="${current.rating === n ? 'is-selected' : ''}">${n}</button>`);
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
      toast(t('vote.toast.saved'));
      showResults(fresh, savedSession, games);
    } catch (e) { toast(e.message); }
  }

  render();
}

// =================== Results ===================

async function showResults(round, session, gamesHint) {
  currentView = () => showResults(round, session, gamesHint);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(round.id) },
    { label: t('result.crumb') },
  ]);

  // Resolve the session's game objects.
  const games = session.gameIds
    .map((gid) => round.games.find((g) => g.id === gid) || (gamesHint || []).find((g) => g.id === gid))
    .filter(Boolean);
  const members = round.members;

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

  app.innerHTML = '';
  const when = fmtDateTime(session.createdAt);
  const head = h(`<div class="page-head"><div>
         <h1 class="result-title">${esc(t('result.title'))}</h1>
         <div class="muted">${esc(t('result.subtitle', { when, n: games.length }))}</div>
       </div></div>`);
  app.appendChild(head);
  const titleEl = head.querySelector('.result-title');

  function updateTitle() {
    if (finished && chosenId) {
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

  const medals = ['🥇', '🥈', '🥉'];
  const maxBar = Math.max(1, ...rows.map((r) => Math.max(...r.dist)));
  const rowRefs = [];

  rows.forEach((r, i) => {
    const g = r.game;
    const imgStyle = g.image ? `style="background-image:url('${g.image}')"` : '';
    const fallback = g.image ? '' : (g.type === 'digital' ? '💻' : '🎲');
    const bars = r.dist
      .map((c, n) => {
        const hpx = 4 + Math.round((c / maxBar) * 24);
        return `<div class="bar" style="height:${hpx}px" title="${esc(t('result.barTitle', { c, r: n + 1 }))}">${c || ''}</div>`;
      })
      .join('');
    // Info if the game has been retired in the meantime.
    const retiredBadge = g.retired ? ` <span class="tag tag--retired">${t('result.retiredTag')}</span>` : '';
    // "Suggested for retirement" line; with a direct action if not retired yet.
    const sortFlag = r.sortCount
      ? `<div class="sort-flag">${esc(t('result.sortFlag', { n: r.sortCount }))}${
          g.retired ? '' : ` <button class="link-btn sortflag-btn">${esc(t('result.retireNow'))}</button>`
        }</div>`
      : '';
    const medal = i < 3 ? `<span class="rank-medal">${medals[i]}</span>` : '';
    const row = h(`<div class="result-row">
         <div class="result-row__img" ${imgStyle}>${fallback}</div>
         <div>
           <div class="result-row__title">${medal}${esc(g.title)} ${typeTag(g.type)} ${durationTag(g.duration)}${retiredBadge}</div>
           <div class="result-row__bars">${bars}</div>
           ${sortFlag}
         </div>
         <div class="result-row__score">
           <div class="score-big">${r.count ? r.avg.toFixed(1) : '–'}</div>
           <div class="score-label">${esc(t('result.avgOf', { n: r.count }))}</div>
           <button class="btn play-btn">${esc(t('result.play'))}</button>
         </div>
         <div class="row-finish" hidden></div>
       </div>`);
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
      btn.textContent = isChosen ? t('result.willPlay') : t('result.play');
      // Once the result is recorded, the choice can no longer be changed.
      btn.disabled = finished;
      btn.title = finished ? t('result.lockedHint') : '';
    });
    if (chosenId) {
      const g = games.find((x) => x.id === chosenId);
      banner.innerHTML = t('result.bannerChosen', { title: '<strong>' + esc(g ? g.title : '') + '</strong>' });
      banner.classList.add('is-set');
    } else {
      banner.textContent = t('result.bannerPrompt');
      banner.classList.remove('is-set');
    }
    renderFinish();
  }

  // --- Finish game / record winners (rendered inside the chosen game's tile) ---
  let finished = !!session.finished;
  let winnerIds = Array.isArray(session.winnerIds) ? session.winnerIds.slice() : [];

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
      h(`<h3>${esc(finished ? t('result.finishTitleDone') : t('result.finishTitle'))}</h3>`)
    );
    finishWrap.appendChild(
      h(`<div class="muted" style="margin-bottom:10px">${esc(t('result.whoWon', { game: chosenGame ? chosenGame.title : '' }))}</div>`)
    );

    const chips = h('<div class="winner-chips"></div>');
    members.forEach((m) => {
      const sel = winnerIds.includes(m.id);
      const chip = h(`<button class="winner-chip ${sel ? 'is-selected' : ''}">${sel ? '🏆 ' : ''}${esc(m.name)}</button>`);
      chip.addEventListener('click', () => {
        winnerIds = winnerIds.includes(m.id)
          ? winnerIds.filter((x) => x !== m.id)
          : [...winnerIds, m.id];
        renderFinish();
      });
      chips.appendChild(chip);
    });
    finishWrap.appendChild(chips);

    const actions = h('<div class="toolbar" style="margin-top:14px"></div>');
    const saveBtn = h(`<button class="btn btn--primary">${esc(finished ? t('result.update') : t('result.markPlayed'))}</button>`);
    saveBtn.addEventListener('click', async () => {
      try {
        const saved = await api('POST', `/api/rounds/${round.id}/sessions/${session.id}/finish`, {
          finished: true,
          winnerIds,
        });
        finished = true;
        winnerIds = saved.winnerIds.slice(); // filtered server-side
        session.finished = true;
        session.winnerIds = winnerIds.slice();
        toast(t('result.toast.saved'));
        renderFinish();
      } catch (e) { toast(e.message); }
    });
    actions.appendChild(saveBtn);

    if (finished) {
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
    }
    finishWrap.appendChild(actions);

    if (finished) {
      const names = winnerIds
        .map((wid) => (members.find((m) => m.id === wid) || {}).name)
        .filter(Boolean);
      const txt = names.length
        ? t('result.winners', { names: names.join(', ') })
        : t('result.playedNoWinner');
      finishWrap.appendChild(h(`<div class="winner-result">${esc(txt)}</div>`));
    }
  }

  updateChosen();

  const back = h(`<div class="section center"><button class="btn btn--lg">${esc(t('common.backToRound'))}</button></div>`);
  back.querySelector('button').addEventListener('click', () => showRound(round.id));
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
