/* Familien-Spielesammlung – views: home, new round, activity feed.
   Part of the frontend; all files share one global script scope. */

// =================== Home: rounds ===================

async function showHome() {
  currentView = () => showHome();
  setCrumbs([{ label: t('nav.home') }]);
  applyBackground(null); // home: default background
  app.innerHTML = '<p class="muted">…</p>';
  const rounds = await api('GET', '/api/rounds');

  app.innerHTML = '';
  app.appendChild(h(`<div class="page-head"><h1>${esc(t('home.title'))}</h1></div>`));

  const newBtn = h(`<button class="btn btn--primary btn--lg">${esc(t('home.newRound'))}</button>`);
  newBtn.addEventListener('click', showNewRound);
  app.appendChild(newBtn);
  app.appendChild(h('<div class="spacer"></div>'));

  if (rounds.length === 0) {
    app.appendChild(
      h(`<div class="empty"><p>${esc(t('home.empty.title'))}</p>
           <p class="muted">${esc(t('home.empty.sub'))}</p></div>`)
    );
    return;
  }

  const grid = h('<div class="cards section"></div>');
  rounds.forEach((r) => {
    const card = h(`<div class="card">
         <h3>${esc(r.name)}</h3>
         <div class="card__meta">${esc(t('home.card.meta', { m: r.memberCount, g: r.gameCount, s: r.sessionCount }))}</div>
       </div>`);
    card.addEventListener('click', () => showRound(r.id));
    grid.appendChild(card);
  });
  app.appendChild(grid);
}

// =================== New round ===================

async function showNewRound() {
  currentView = () => showNewRound();
  setCrumbs([{ label: t('nav.home'), onClick: showHome }, { label: t('newRound.crumb') }]);
  applyBackground(null);
  app.innerHTML = '<p class="muted">…</p>';

  // Rounds whose games list can be copied over.
  const allRounds = await api('GET', '/api/rounds');
  const importable = allRounds.filter((r) => r.gameCount > 0);
  const importField = importable.length
    ? `<div class="field">
        <label for="importSel">${esc(t('newRound.importLabel'))}</label>
        <select id="importSel" class="select">
          <option value="">${esc(t('newRound.importNone'))}</option>
          ${importable.map((r) => `<option value="${r.id}">${esc(t('newRound.importOption', { name: r.name, n: r.gameCount }))}</option>`).join('')}
        </select>
        <div class="muted" style="margin-top:6px;font-size:14px">${esc(t('newRound.importNote'))}</div>
      </div>`
    : '';

  app.innerHTML = '';
  app.appendChild(h(`<div class="page-head"><h1>${esc(t('newRound.title'))}</h1></div>`));

  const form = h(`<div>
      <div class="field">
        <label for="roundName">${esc(t('newRound.nameLabel'))}</label>
        <input id="roundName" class="input" placeholder="${esc(t('newRound.namePlaceholder'))}" />
      </div>
      <div class="field">
        <label>${esc(t('newRound.membersLabel'))}</label>
        <div class="row">
          <input id="memberInput" class="input" placeholder="${esc(t('newRound.memberPlaceholder'))}" />
          <button id="addMember" class="btn">${esc(t('newRound.add'))}</button>
        </div>
        <div id="memberList" class="member-list"></div>
      </div>
      ${importField}
      <div class="toolbar">
        <button id="createRound" class="btn btn--primary btn--lg">${esc(t('newRound.create'))}</button>
      </div>
    </div>`);
  app.appendChild(form);

  const members = [];
  const nameInput = form.querySelector('#roundName');
  const memberInput = form.querySelector('#memberInput');
  const memberList = form.querySelector('#memberList');

  function renderMembers() {
    memberList.innerHTML = '';
    members.forEach((m, i) => {
      const pill = h(`<span class="member-pill">${esc(m)} <button class="link-btn">✕</button></span>`);
      pill.querySelector('button').addEventListener('click', () => {
        members.splice(i, 1);
        renderMembers();
      });
      memberList.appendChild(pill);
    });
  }
  function addMember() {
    const v = memberInput.value.trim();
    if (!v) return;
    members.push(v);
    memberInput.value = '';
    memberInput.focus();
    renderMembers();
  }
  form.querySelector('#addMember').addEventListener('click', addMember);
  memberInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addMember(); }
  });

  form.querySelector('#createRound').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return toast(t('newRound.toast.needName'));
    if (members.length === 0) return toast(t('newRound.toast.needMember'));
    const importSel = form.querySelector('#importSel');
    const body = { name, members };
    if (importSel && importSel.value) body.importFromRoundId = importSel.value;
    try {
      const round = await api('POST', '/api/rounds', body);
      toast(body.importFromRoundId ? t('newRound.toast.createdImported') : t('newRound.toast.created'));
      showRound(round.id);
    } catch (e) { toast(e.message); }
  });

  nameInput.focus();
}

// Build a round's activity feed: persisted game events plus session entries
// derived from live status, newest first.
function buildActivityFeed(round) {
  const entries = [];

  // Navigate to the game's detail page, if the game still exists.
  const gameNav = (gameId) => {
    if (!gameId || !round.games.some((g) => g.id === gameId)) return null;
    return () => showGameDetail(round.id, gameId);
  };

  (round.activities || []).forEach((a) => {
    if (a.type === 'game_added')
      entries.push({ id: a.id, at: a.at, icon: '➕', text: t('activity.gameAdded', { title: a.title }), nav: gameNav(a.gameId) });
    else if (a.type === 'game_retired')
      entries.push({ id: a.id, at: a.at, icon: '🗑️', text: t('activity.gameRetired', { title: a.title }), nav: () => showRetired(round.id) });
    else if (a.type === 'game_restored')
      entries.push({ id: a.id, at: a.at, icon: '↩︎', text: t('activity.gameRestored', { title: a.title }), nav: gameNav(a.gameId) });
    else if (a.type === 'game_deleted')
      entries.push({ id: a.id, at: a.at, icon: '✕', text: t('activity.gameDeleted', { title: a.title }) });
  });

  round.sessions.forEach((s) => {
    if (!s.done) return; // running vote not in the feed yet
    const game = s.chosenGameId && round.games.find((g) => g.id === s.chosenGameId);
    const gname = game ? game.title : null;
    const nav = () => showResults(round, s);
    if (s.finished) {
      const names = (s.winnerIds || [])
        .map((wid) => (round.members.find((m) => m.id === wid) || {}).name)
        .filter(Boolean);
      const at = s.finishedAt || s.chosenAt || s.createdAt;
      if (gname && names.length)
        entries.push({
          at,
          icon: '🏆',
          text: t(names.length === 1 ? 'activity.wonOne' : 'activity.wonMany', { names: joinNames(names), game: gname }),
          nav,
        });
      else if (gname) entries.push({ at, icon: '🎲', text: t('activity.played', { game: gname }), nav });
      else entries.push({ at, icon: '🎲', text: t('activity.sessionPlayed'), nav });
    } else if (gname) {
      entries.push({ at: s.chosenAt || s.createdAt, icon: '▶️', text: t('activity.started', { game: gname }), nav });
    } else {
      entries.push({ at: s.createdAt, icon: '🗳️', text: t('activity.voteDone'), nav });
    }
  });

  entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return entries;
}
