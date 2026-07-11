/* Spieleabend – views: home (lobby), new round.
   Part of the frontend; all files share one global script scope. */

// =================== Home: lobby ===================

async function showHome() {
  currentView = () => showHome();
  syncUrl('/');
  setCrumbs([{ label: t('nav.home') }]);
  applyBackground(null); // home: default background
  app.innerHTML = '<p class="muted">…</p>';
  const rounds = await api('GET', '/api/rounds');

  app.innerHTML = '';
  app.appendChild(
    h(`<div class="lobby-head">
         <h1>${esc(t('home.greeting'))}</h1>
         <div class="muted lobby-head__sub">${esc(t('home.sub'))}</div>
       </div>`)
  );

  if (rounds.length === 0) {
    app.appendChild(
      h(`<div class="empty"><p>${esc(t('home.empty.title'))}</p>
           <p class="muted">${esc(t('home.empty.sub'))}</p></div>`)
    );
  }

  const list = h('<div class="lobby-list"></div>');
  rounds.forEach((r) => {
    // Members ride along in the summary so the avatars get their colors.
    const stack = r.members
      .map(
        (m) =>
          `<span class="avatar" style="background:${memberColor(r, m.id)}" title="${esc(m.name)}">${esc(initials(m.name))}</span>`
      )
      .join('');

    let lastLine = '';
    if (r.lastPlayed) {
      const lp = r.lastPlayed;
      const text = lp.winnerNames.length
        ? t(lp.winnerNames.length === 1 ? 'home.lastPlayedWonOne' : 'home.lastPlayedWonMany', {
            game: lp.gameTitle,
            names: joinNames(lp.winnerNames),
          })
        : t('home.lastPlayed', { game: lp.gameTitle });
      lastLine = `<span class="round-card__last"><i class="ti ti-trophy" aria-hidden="true"></i>${esc(text)}</span>`;
    }

    const card = h(`<button class="round-card">
         <span class="round-card__emblem" style="background:${themeAccent(r.background)}"><i class="ti ti-dice-5" aria-hidden="true"></i></span>
         <span class="round-card__body">
           <span class="round-card__name">${esc(r.name)}</span>
           <span class="round-card__meta">
             <span class="avatar-stack">${stack}</span>
             <span class="stat-chip"><i class="ti ti-cards" aria-hidden="true"></i>${esc(tn(r.gameCount, 'home.chip.gamesOne', 'home.chip.games'))}</span>
             <span class="stat-chip"><i class="ti ti-confetti" aria-hidden="true"></i>${esc(tn(r.playedCount, 'home.chip.sessionsOne', 'home.chip.sessions'))}</span>
           </span>
           ${lastLine}
         </span>
         <i class="ti ti-chevron-right round-card__chev" aria-hidden="true"></i>
       </button>`);
    card.addEventListener('click', () => showRound(r.id));
    list.appendChild(card);
  });

  const newCard = h(
    `<button class="round-card round-card--new"><i class="ti ti-plus" aria-hidden="true"></i>${esc(t('home.newRound'))}</button>`
  );
  newCard.addEventListener('click', showNewRound);
  list.appendChild(newCard);
  app.appendChild(list);
}

// =================== New round ===================

async function showNewRound() {
  currentView = () => showNewRound();
  syncUrl('/round/new');
  setCrumbs([{ label: t('nav.home'), onClick: showHome }, { label: t('newRound.crumb') }]);
  applyBackground(null);
  app.innerHTML = '<p class="muted">…</p>';

  // Rounds whose games list can be copied over.
  const allRounds = await api('GET', '/api/rounds');
  const importable = allRounds.filter((r) => r.gameCount > 0);
  const importField = importable.length
    ? `<div class="field import-card">
        <i class="ti ti-copy import-card__icon" aria-hidden="true"></i>
        <div class="import-card__body">
          <label for="importSel">${esc(t('newRound.importLabel'))}</label>
          <select id="importSel" class="select">
            <option value="">${esc(t('newRound.importNone'))}</option>
            ${importable.map((r) => `<option value="${r.id}">${esc(t('newRound.importOption', { name: r.name, n: r.gameCount }))}</option>`).join('')}
          </select>
          <div class="muted import-card__note">${esc(t('newRound.importNote'))}</div>
        </div>
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
        <div class="nr-table">
          <div class="nr-table__ring"></div>
          <div class="nr-table__center"></div>
        </div>
        <div class="row">
          <input id="memberInput" class="input" placeholder="${esc(t('newRound.memberPlaceholder'))}" />
          <button id="addMember" class="btn">${esc(t('newRound.add'))}</button>
        </div>
      </div>
      ${importField}
      <div class="toolbar">
        <button id="createRound" class="btn btn--primary btn--lg"><i class="ti ti-sparkles" aria-hidden="true"></i> ${esc(t('newRound.create'))}</button>
      </div>
    </div>`);
  app.appendChild(form);

  const members = [];
  const nameInput = form.querySelector('#roundName');
  const memberInput = form.querySelector('#memberInput');
  const table = form.querySelector('.nr-table');
  const tableCenter = form.querySelector('.nr-table__center');

  // Seats sit evenly on an ellipse around the table: all members plus one
  // dashed empty seat that focuses the name input.
  function renderMembers() {
    table.querySelectorAll('.nr-seat').forEach((el) => el.remove());
    tableCenter.textContent = members.length
      ? t('newRound.tableCount', { n: members.length })
      : t('newRound.tableEmpty');
    const cx = 140, cy = 118, rx = 112, ry = 92;
    const seats = members.length + 1; // + empty seat
    for (let i = 0; i < seats; i++) {
      const angle = ((-90 + (i * 360) / seats) * Math.PI) / 180;
      const x = cx + rx * Math.cos(angle);
      const y = cy + ry * Math.sin(angle);
      const isEmpty = i === members.length;
      const seat = isEmpty
        ? h(`<button type="button" class="nr-seat nr-seat--empty" title="${esc(t('newRound.add'))}">
               <span class="nr-seat__avatar"><i class="ti ti-plus" aria-hidden="true"></i></span>
             </button>`)
        : h(`<button type="button" class="nr-seat" title="${esc(t('newRound.removeHint'))}">
               <span class="nr-seat__avatar" style="background:${MEMBER_COLORS[i % MEMBER_COLORS.length]}">${esc(initials(members[i]))}</span>
               <span class="nr-seat__name">${esc(members[i])}</span>
             </button>`);
      seat.style.left = x + 'px';
      seat.style.top = y - 23 + 'px';
      if (isEmpty) {
        seat.addEventListener('click', () => memberInput.focus());
      } else {
        const idx = i;
        seat.addEventListener('click', () => {
          members.splice(idx, 1);
          renderMembers();
        });
      }
      table.appendChild(seat);
    }
  }
  renderMembers();
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
