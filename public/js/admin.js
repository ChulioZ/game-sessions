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
    confirm_mismatch: 'Die eingegebene E-Mail-Adresse stimmt nicht mit dem Konto überein.',
    tenant_shared: 'Abgebrochen: Auf diesem Tenant liegt noch ein weiteres Konto. '
      + 'Die Daten gehören auch diesem Konto und werden nicht gelöscht.',
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
    loadStatus();
    loadUsers();
    loadFeedback();
    loadLog();
  }

  // ---- instance status (#274) ----------------------------------------------

  // Each row is [label, verdict, value, note?]. The verdict drives the pill
  // colour: 'ok' = as intended, 'warn' = works but probably not what you meant,
  // 'off' = a real misconfiguration. Deriving it HERE rather than server-side is
  // deliberate — the server reports facts, the panel interprets them, so a new
  // opinion about what "good" looks like never changes the API.
  function statusRows(s) {
    const yesNo = (b) => (b ? 'ja' : 'nein');
    const rows = [];

    // Accounts: the flag being on while `enabled` is false means SESSION_SECRET
    // is missing — the app silently stays in legacy mode.
    rows.push(['Accounts (Registrierung)',
      s.accounts.enabled ? 'ok' : (s.accounts.flagSet ? 'off' : 'warn'),
      s.accounts.enabled ? 'aktiv' : 'aus',
      s.accounts.flagSet && !s.accounts.enabled
        ? 'ACCOUNTS_ENABLED ist gesetzt, aber SESSION_SECRET fehlt — die Instanz läuft weiter im Alt-Modus.'
        : null]);

    rows.push(['SESSION_SECRET',
      !s.accounts.sessionSecretSet ? 'warn' : (s.accounts.sessionSecretDistinct ? 'ok' : 'off'),
      !s.accounts.sessionSecretSet ? 'nicht gesetzt' : (s.accounts.sessionSecretDistinct ? 'eigenständig' : 'gleich AUTH_PASSWORD'),
      s.accounts.sessionSecretSet && !s.accounts.sessionSecretDistinct
        ? 'Muss ein eigenes Geheimnis sein — sonst kann jedes Gruppenmitglied Tokens fälschen.'
        : null]);

    rows.push(['ADMIN_PASSWORD',
      !s.admin.enabled ? 'warn' : (s.admin.secretDistinct ? 'ok' : 'off'),
      !s.admin.enabled ? 'nicht gesetzt' : (s.admin.secretDistinct ? 'eigenständig' : 'gleich AUTH_PASSWORD'),
      s.admin.enabled && !s.admin.secretDistinct
        ? 'Rechteausweitung: Jede Person mit dem App-Passwort hätte Operator-Rechte.'
        : null]);

    rows.push(['E-Mail-Versand', s.mail.configured ? 'ok' : 'off',
      s.mail.configured ? 'Brevo konfiguriert' : 'nur Outbox (kein Versand)',
      s.mail.configured ? null
        : 'Ohne BREVO_API_KEY landen Verifizierungs- und Reset-Mails im Speicher und werden nie zugestellt.']);

    rows.push(['MAIL_FROM / APP_BASE_URL',
      s.mail.fromSet && s.mail.baseUrlSet ? 'ok' : 'warn',
      `${yesNo(s.mail.fromSet)} / ${yesNo(s.mail.baseUrlSet)}`]);

    rows.push(['Bild-Speicher', s.storage.images === 's3' ? 'ok' : 'warn',
      s.storage.images === 's3' ? 'S3 / R2' : 'lokale Festplatte',
      s.storage.images === 's3' ? null
        : 'Ohne S3_BUCKET liegen Cover im Container und sind nach dem nächsten Deploy weg.']);

    rows.push(['Datenspeicher', s.storage.data === 'postgres' ? 'ok' : 'warn',
      s.storage.data === 'postgres' ? 'PostgreSQL' : 'data.json',
      s.storage.data === 'postgres' ? null
        : 'Ohne DATABASE_URL liegen die Runden in einer Datei im Container.']);

    rows.push(['Migrationen',
      s.migrations.pending ? 'off' : 'ok',
      s.migrations.backend === 'json'
        ? 'entfällt (JSON)'
        : `${s.migrations.latest || 'keine'}${s.migrations.pending ? ` · ${s.migrations.pending} offen` : ''}`,
      s.migrations.pending ? 'Der Code ist neuer als das Schema — dieser Deploy hat nicht migriert.' : null]);

    rows.push(['Kontingente', s.quotas.enforced ? 'ok' : 'warn',
      s.quotas.enforced ? 'aktiv' : 'inaktiv (Accounts aus)',
      `Runden/Tenant ${s.quotas.roundsPerTenant} · Spiele/Runde ${s.quotas.gamesPerRound} · Tags/Runde ${s.quotas.tagsPerRound}`]);

    rows.push(['Kanonische Domain', 'ok', s.hosts.canonical,
      s.hosts.redirects.length ? `Weiterleitung: ${s.hosts.redirects.join(', ')}` : 'keine Weiterleitungen']);

    rows.push(['Assets', s.assets.built ? 'ok' : 'warn',
      s.assets.built ? 'gebautes dist/' : 'public/ (ungebaut)',
      s.assets.built ? null : 'Ohne Build greift kein Cache-Busting — Clients können alte JS/CSS behalten.']);

    rows.push(['Version', 'ok',
      `${s.app.version || '—'}${s.app.commit ? ` · ${s.app.commit}` : ''}`,
      `NODE_ENV: ${s.app.nodeEnv || '—'} · Laufzeit: ${formatUptime(s.app.uptimeSeconds)}`]);

    return rows;
  }

  function formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return `${d} d ${h} h`;
    if (h) return `${h} h ${m} min`;
    return `${m} min`;
  }

  async function loadStatus() {
    const grid = $('statusGrid');
    grid.replaceChildren();
    hide($('statusError'));

    let status;
    try {
      ({ status } = await api('/status'));
    } catch (err) {
      show($('statusError'), message(err), 'err');
      return;
    }

    for (const [label, verdict, value, note] of statusRows(status)) {
      const item = document.createElement('div');
      item.className = 'status__item';

      const head = document.createElement('div');
      head.className = 'status__label';
      head.textContent = label;
      item.appendChild(head);

      const pill = document.createElement('span');
      pill.className = `pill pill--${verdict}`;
      pill.textContent = value;
      item.appendChild(pill);

      if (note) {
        const hint = document.createElement('div');
        hint.className = 'status__note';
        hint.textContent = note;
        item.appendChild(hint);
      }

      grid.appendChild(item);
    }
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
      const actions = document.createElement('div');
      actions.className = 'row';
      for (const [label, cls, run] of [
        [u.disabled ? 'Entsperren' : 'Sperren', u.disabled ? 'small ghost' : 'small danger', () => toggleUser(u)],
        ['Exportieren', 'small ghost', () => exportUser(u)],
        ['Löschen', 'small danger', () => eraseUser(u)],
      ]) {
        const btn = document.createElement('button');
        btn.className = cls;
        btn.textContent = label;
        btn.addEventListener('click', run);
        actions.appendChild(btn);
      }
      action.appendChild(actions);

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

  // ---- export & erasure (#273) ---------------------------------------------

  // Ask for the mandatory reason. A cancelled prompt (null) aborts; an empty
  // string would be rejected by the server anyway, so treat it the same rather
  // than sending a doomed request.
  function askReason(label) {
    const reason = window.prompt(`${label}: Begründung (wird protokolliert)`);
    return reason && reason.trim() ? reason : null;
  }

  // Art. 15/20. The response is JSON rather than a download URL because the
  // required reason travels in the request body (see routes/admin.js) — so the
  // file is assembled here and saved via an object URL.
  async function exportUser(user) {
    const reason = askReason('Export');
    if (!reason) return;

    try {
      const out = await api(`/users/${encodeURIComponent(user.id)}/export`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      const blob = new Blob([JSON.stringify(out.export, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `spielwirbel-export-${user.id}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      // Revoked on the next tick, not inline: the click only *starts* the
      // download, and tearing the object URL down in the same task can cancel it
      // before the browser has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      show($('usersError'), `Export erstellt: ${out.export.rounds.length} Runde(n).`, 'ok');
      loadLog();
    } catch (err) {
      show($('usersError'), message(err), 'err');
    }
  }

  // Art. 17. Irreversible and cascading, so the operator types the account's own
  // address to confirm — the server checks it too, so a mis-clicked row refuses
  // rather than erasing the wrong person.
  async function eraseUser(user) {
    const confirmEmail = window.prompt(
      `Konto und ALLE Daten dieses Tenants endgültig löschen.\n\n`
      + `Nicht umkehrbar. Zum Bestätigen die E-Mail-Adresse des Kontos eingeben:`,
    );
    if (!confirmEmail) return;

    const reason = askReason('Löschung');
    if (!reason) return;

    try {
      const out = await api(`/users/${encodeURIComponent(user.id)}/erase`, {
        method: 'POST',
        body: JSON.stringify({ reason, confirmEmail }),
      });
      const failed = out.imagesFailed ? `, ${out.imagesFailed} Bild(er) nicht entfernt` : '';
      // Refresh BEFORE reporting: loadUsers() clears this same message element.
      await loadUsers();
      loadLog();
      show($('usersError'),
        `Gelöscht: ${out.rounds} Runde(n), ${out.imagesRemoved} Bild(er)${failed}.`, 'ok');
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

  // ---- feedback (#260) -----------------------------------------------------

  // In-app user feedback, newest first. Read-only: there is no action to take
  // here beyond reading, so unlike the accounts table this renders no buttons.
  async function loadFeedback() {
    const body = $('feedbackTable').querySelector('tbody');
    body.replaceChildren();
    hide($('feedbackError'));
    let entries;
    try {
      ({ entries } = await api('/feedback'));
    } catch (err) {
      show($('feedbackError'), message(err), 'err');
      return;
    }

    const head = document.createElement('tr');
    ['Zeitpunkt', 'Nachricht', 'Kontext', 'Kontakt'].forEach((h) => cell(head, h, { head: true }));
    body.appendChild(head);

    if (!entries.length) {
      const row = document.createElement('tr');
      cell(row, 'Noch kein Feedback.', { colSpan: 4 });
      body.appendChild(row);
      return;
    }

    for (const f of entries) {
      const ctx = f.context || {};
      const row = document.createElement('tr');
      cell(row, fmt(f.createdAt));
      // The message is user-authored free text — cell() uses textContent, so it
      // is never interpreted as markup on this privileged page. `pre-wrap` keeps
      // the submitter's own line breaks readable.
      cell(row, f.message).style.whiteSpace = 'pre-wrap';
      cell(row, [ctx.path, ctx.locale, ctx.tenantId].filter(Boolean).join(' · ') || '—');
      // Only present when the submitter explicitly opted in; anonymous is the
      // default, so an em dash here is the normal case, not missing data.
      cell(row, ctx.email || '—');
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
