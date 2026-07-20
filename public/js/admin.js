'use strict';

/*
 * Standalone operator moderation page script (issue #268). Like login.js, it is
 * NOT part of the SPA's shared global scope — wrapped in an IIFE so it declares
 * no top-level names and needs no entry in eslint.config.js's frontendGlobals
 * (see .claude/rules/eslint-frontend-shared-scope.md).
 *
 * Every call goes to /api/admin, authenticated by the httpOnly `aid` cookie the
 * login sets — there is no token to hold in JS. GET /api/admin/me is the session
 * probe: 200 = signed in, 401 = not, 404 = the surface is disabled entirely.
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const loginForm = $('loginForm');
  const panel = $('panel');
  let currentImage = null;

  // ---- helpers -------------------------------------------------------------

  async function api(path, options) {
    const res = await fetch(`/api/admin${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* a non-JSON error page (e.g. a proxy 502) — keep the status below */
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  function show(el, text, kind) {
    el.textContent = text;
    el.className = `msg msg--${kind}`;
    el.hidden = false;
  }

  const hide = (el) => { el.hidden = true; };

  // Server errors are English codes (CLAUDE.md: server messages stay English);
  // map the ones an operator can actually hit to German, and fall back to the
  // raw code so nothing is ever swallowed silently.
  const MESSAGES = {
    not_found: 'Nicht gefunden.',
    invalid_password: 'Falsches Passwort.',
    admin_auth_required: 'Sitzung abgelaufen. Bitte neu anmelden.',
    admin_disabled: 'Die Moderationsoberfläche ist auf dieser Instanz nicht aktiviert.',
    rate_limited: 'Zu viele Versuche. Bitte kurz warten.',
  };
  const message = (err) => MESSAGES[err.message] || err.message;

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('de-DE') : '—');

  // textContent everywhere below (never innerHTML with server data): a game
  // title or e-mail is attacker-controlled content, and this page runs with
  // operator privileges.
  function cell(row, text, opts = {}) {
    const el = document.createElement(opts.head ? 'th' : 'td');
    el.textContent = text;
    if (opts.colSpan) el.colSpan = opts.colSpan;
    row.appendChild(el);
    return el;
  }

  // ---- login ---------------------------------------------------------------

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = loginForm.querySelector('button');
    hide($('loginError'));
    button.disabled = true;
    try {
      await api('/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
      enterPanel();
    } catch (err) {
      show($('loginError'), message(err), 'err');
      $('password').select();
    } finally {
      button.disabled = false;
    }
  });

  $('logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.reload();
  });

  function enterPanel() {
    loginForm.hidden = true;
    panel.hidden = false;
    $('password').value = '';
    loadUsers();
    loadLog();
  }

  // ---- lookup --------------------------------------------------------------

  $('lookupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hide($('lookupError'));
    hide($('lookupResult'));
    $('takedownCard').hidden = true;
    currentImage = null;

    const image = $('image').value.trim();
    try {
      const owner = await api(`/lookup?image=${encodeURIComponent(image)}`);
      renderLookup(owner);
      currentImage = owner.image;
      $('takedownCard').hidden = false;
      hide($('takedownMsg'));
    } catch (err) {
      show($('lookupError'), message(err), 'err');
    }
  });

  function renderLookup(owner) {
    const box = $('lookupResult');
    box.replaceChildren();
    const dl = document.createElement('dl');
    const pairs = [
      ['Spiel', owner.gameTitle],
      ['Runde', owner.roundName],
      ['Tenant', owner.tenantId],
      ['Konten', owner.users.length ? owner.users.map((u) => u.email).join(', ') : 'keine (Alt-Tenant)'],
    ];
    for (const [k, v] of pairs) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    box.appendChild(dl);
    box.hidden = false;
  }

  // ---- takedown ------------------------------------------------------------

  $('takedownForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentImage) return;
    if (!window.confirm(`Bild ${currentImage} endgültig entfernen?`)) return;

    const button = $('takedownForm').querySelector('button');
    button.disabled = true;
    try {
      const out = await api('/takedown', {
        method: 'POST',
        body: JSON.stringify({ image: currentImage, reason: $('takedownReason').value }),
      });
      show($('takedownMsg'), `Entfernt. Referenzen bereinigt: ${out.cleared}.`, 'ok');
      $('takedownReason').value = '';
      hide($('lookupResult'));
      currentImage = null;
      loadLog();
    } catch (err) {
      show($('takedownMsg'), message(err), 'err');
    } finally {
      button.disabled = false;
    }
  });

  // ---- users ---------------------------------------------------------------

  async function loadUsers() {
    const body = $('usersTable').querySelector('tbody');
    body.replaceChildren();
    hide($('usersError'));
    let users;
    try {
      ({ users } = await api('/users'));
    } catch (err) {
      show($('usersError'), message(err), 'err');
      return;
    }

    const head = document.createElement('tr');
    ['E-Mail', 'Tenant', 'Status', ''].forEach((h) => cell(head, h, { head: true }));
    body.appendChild(head);

    if (!users.length) {
      const row = document.createElement('tr');
      cell(row, 'Keine Konten (Accounts sind auf dieser Instanz nicht aktiv).', { colSpan: 4 });
      body.appendChild(row);
      return;
    }

    for (const u of users) {
      const row = document.createElement('tr');
      cell(row, u.email);
      cell(row, u.tenantId || '—');

      const status = cell(row, '');
      const pill = document.createElement('span');
      pill.className = u.disabled ? 'pill pill--off' : 'pill';
      pill.textContent = u.disabled ? 'gesperrt' : 'aktiv';
      status.appendChild(pill);
      if (u.disabled && u.disabledReason) {
        const why = document.createElement('div');
        why.style.color = '#8b93a6';
        why.style.fontSize = '0.8rem';
        why.textContent = u.disabledReason;
        status.appendChild(why);
      }

      const action = cell(row, '');
      const btn = document.createElement('button');
      btn.className = u.disabled ? 'small ghost' : 'small danger';
      btn.textContent = u.disabled ? 'Entsperren' : 'Sperren';
      btn.addEventListener('click', () => toggleUser(u));
      action.appendChild(btn);

      body.appendChild(row);
    }
  }

  async function toggleUser(user) {
    const disabling = !user.disabled;
    const reason = window.prompt(
      `${disabling ? 'Sperren' : 'Entsperren'}: Begründung (wird protokolliert)`,
    );
    // A cancelled prompt (null) aborts; an empty string would be rejected by the
    // server anyway, so treat it the same rather than sending a doomed request.
    if (!reason || !reason.trim()) return;

    try {
      await api(`/users/${encodeURIComponent(user.id)}/disabled`, {
        method: 'POST',
        body: JSON.stringify({ disabled: disabling, reason }),
      });
      loadUsers();
      loadLog();
    } catch (err) {
      show($('usersError'), message(err), 'err');
    }
  }

  // ---- log -----------------------------------------------------------------

  async function loadLog() {
    const body = $('logTable').querySelector('tbody');
    body.replaceChildren();
    let entries;
    try {
      ({ entries } = await api('/log'));
    } catch {
      return; // the users panel already surfaces a dead session
    }

    const head = document.createElement('tr');
    ['Zeitpunkt', 'Aktion', 'Ziel', 'Begründung'].forEach((h) => cell(head, h, { head: true }));
    body.appendChild(head);

    if (!entries.length) {
      const row = document.createElement('tr');
      cell(row, 'Noch keine Einträge.', { colSpan: 4 });
      body.appendChild(row);
      return;
    }

    for (const e of entries) {
      const row = document.createElement('tr');
      cell(row, fmt(e.at));
      cell(row, e.action);
      cell(row, e.gameTitle ? `${e.gameTitle} (${e.target})` : e.email || e.target);
      cell(row, e.reason || '—');
      body.appendChild(row);
    }
  }

  // ---- boot ----------------------------------------------------------------

  // Probe for an existing session so a reload doesn't force a re-login. A 404
  // (surface disabled) is reported on the login card rather than left blank.
  api('/me')
    .then(enterPanel)
    .catch((err) => {
      if (err.message === 'admin_disabled') show($('loginError'), message(err), 'err');
    });
})();
