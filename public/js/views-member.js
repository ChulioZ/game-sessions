/* Spieleabend – view: member detail page. Shows one round member's stats and
   lets the user edit their name and avatar color. Part of the frontend; all
   files share one global script scope (load order: see index.html). */

// Statistics for one member, computed on demand from the round's sessions
// (sessions are the single source of truth, like the game rating averages).
function memberStats(round, mid) {
  const finished = round.sessions.filter((s) => s.finished);

  // Sessions joined: finished sessions whose memberIds include the member.
  // Legacy sessions have no memberIds -> everyone counts as having joined.
  const joined = finished.filter(
    (s) => !Array.isArray(s.memberIds) || s.memberIds.includes(mid)
  );
  const wins = finished.filter((s) => (s.winnerIds || []).includes(mid)).length;
  const winRate = joined.length ? wins / joined.length : null;

  // Every numeric rating this member has given, and the per-game averages used
  // to find their favorite game (only games that still exist in the round).
  const allRatings = [];
  const perGame = {}; // gameId -> [ratings]
  round.sessions.forEach((s) => {
    const votes = s.votes[mid] || {};
    Object.keys(votes).forEach((gid) => {
      const r = votes[gid] && votes[gid].rating;
      if (typeof r !== 'number') return;
      allRatings.push(r);
      if (round.games.some((g) => g.id === gid)) (perGame[gid] = perGame[gid] || []).push(r);
    });
  });
  const avgGiven = allRatings.length
    ? allRatings.reduce((a, b) => a + b, 0) / allRatings.length
    : null;

  // Favorite game(s): highest average this member gave. Ties share the tile.
  let favGames = [];
  let favAvg = null;
  Object.keys(perGame).forEach((gid) => {
    const avg = perGame[gid].reduce((a, b) => a + b, 0) / perGame[gid].length;
    if (favAvg === null || avg > favAvg) {
      favAvg = avg;
      favGames = [gid];
    } else if (avg === favAvg) {
      favGames.push(gid);
    }
  });
  const favorite = favGames.map((gid) => round.games.find((g) => g.id === gid)).filter(Boolean);

  return { wins, joined: joined.length, winRate, avgGiven, favorite, favAvg };
}

async function showMember(rid, mid) {
  currentView = () => showMember(rid, mid);
  app.innerHTML = '<p class="muted">…</p>';
  const round = await api('GET', '/api/rounds/' + rid);
  applyBackground(round.background);
  const member = round.members.find((m) => m.id === mid);
  if (!member) return showRound(rid);
  setCrumbs([
    { label: t('nav.home'), onClick: showHome },
    { label: round.name, onClick: () => showRound(rid) },
    { label: member.name },
  ]);

  app.innerHTML = '';

  // Persist a partial update, then re-render the page from fresh data so the
  // new name/color is reflected here and everywhere it is derived from.
  async function updateMember(fields) {
    try {
      await api('PATCH', `/api/rounds/${rid}/members/${mid}`, fields);
      toast(t('member.saved'));
      showMember(rid, mid);
    } catch (e) {
      toast(e.message);
    }
  }

  const color = memberColor(round, mid);

  // Header: big avatar + editable name.
  const head = h(`<div class="member-head">
       <span class="avatar member-avatar" style="background:${color}">${esc(initials(member.name))}</span>
       <div class="member-head__info">
         <h1></h1>
       </div>
     </div>`);
  const h1 = head.querySelector('h1');
  const nameEl = h(`<span class="gd-title" title="${esc(t('member.editName'))}">${esc(member.name)}</span>`);

  // Click the name → inline input; Enter/blur saves, Escape cancels.
  nameEl.addEventListener('click', () => {
    const input = h('<input class="input gd-title-input" />');
    input.value = member.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let handled = false;
    const commit = () => {
      if (handled) return;
      handled = true;
      const val = input.value.trim();
      if (!val) {
        toast(t('member.toast.needName'));
        input.replaceWith(nameEl);
        return;
      }
      if (val === member.name) {
        input.replaceWith(nameEl); // nothing changed
        return;
      }
      updateMember({ name: val });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { handled = true; input.replaceWith(nameEl); }
    });
  });
  h1.appendChild(nameEl);
  app.appendChild(head);

  // Color picker: the curated MEMBER_COLORS palette (no free hex).
  const colorSec = h(`<div class="section">
       <h3>${esc(t('member.colorLabel'))}</h3>
       <div class="member-swatches"></div>
     </div>`);
  const swatches = colorSec.querySelector('.member-swatches');
  MEMBER_COLORS.forEach((c) => {
    const active = c === color;
    const sw = h(`<button class="member-swatch${active ? ' is-active' : ''}" style="background:${c}" aria-label="${c}">
         <i class="ti ti-check" aria-hidden="true"></i>
       </button>`);
    if (!active) sw.addEventListener('click', () => updateMember({ color: c }));
    swatches.appendChild(sw);
  });
  app.appendChild(colorSec);

  // Statistics, computed on demand from the sessions.
  const st = memberStats(round, mid);
  const statsSec = h(`<div class="section">
       <h3>${esc(t('member.statsTitle'))}</h3>
       <div class="pokale-cards"></div>
     </div>`);
  if (st.joined === 0) {
    statsSec
      .querySelector('h3')
      .insertAdjacentElement('afterend', h(`<div class="muted member-nosessions">${esc(t('member.noSessions'))}</div>`));
  }
  const cards = statsSec.querySelector('.pokale-cards');

  const statCard = (icon, label, value, sub) =>
    h(`<div class="pokale-card">
         <span class="pokale-card__icon"><i class="ti ${icon}" aria-hidden="true"></i></span>
         <span class="pokale-card__label">${esc(label)}</span>
         <span class="pokale-card__value">${esc(value)}</span>
         <span class="pokale-card__sub">${esc(sub)}</span>
       </div>`);

  cards.appendChild(statCard('ti-trophy', t('member.wins'), String(st.wins), ''));
  cards.appendChild(statCard('ti-confetti', t('member.sessions'), String(st.joined), ''));
  cards.appendChild(
    statCard(
      'ti-percentage',
      t('member.winRate'),
      st.winRate === null ? '–' : Math.round(st.winRate * 100) + '%',
      ''
    )
  );
  cards.appendChild(
    statCard('ti-star', t('member.avgGiven'), st.avgGiven === null ? '–' : 'Ø ' + st.avgGiven.toFixed(1), '')
  );

  // Favorite game: one card whose value links to the game detail page(s).
  const favCard = h(`<div class="pokale-card">
       <span class="pokale-card__icon"><i class="ti ti-heart" aria-hidden="true"></i></span>
       <span class="pokale-card__label">${esc(t('member.favorite'))}</span>
       <span class="pokale-card__games"></span>
       <span class="pokale-card__sub">${st.favAvg === null ? '' : esc('Ø ' + st.favAvg.toFixed(1))}</span>
     </div>`);
  const favList = favCard.querySelector('.pokale-card__games');
  if (st.favorite.length) {
    st.favorite.forEach((g) => {
      const row = h(`<span class="pokale-game"><span class="pokale-game__title">${esc(g.title)}</span></span>`);
      makeGameLink(row.querySelector('.pokale-game__title'), rid, g.id);
      favList.appendChild(row);
    });
  } else {
    favList.appendChild(h(`<span class="muted">${esc(t('member.favoriteNone'))}</span>`));
  }
  cards.appendChild(favCard);
  app.appendChild(statsSec);

  const back = h(`<div class="section center"><button class="btn btn--lg">${esc(t('common.backToRound'))}</button></div>`);
  back.querySelector('button').addEventListener('click', () => showRound(rid));
  app.appendChild(back);
}
