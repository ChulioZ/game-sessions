/* Spielwirbel – account/onboarding (issue #138): the in-app "way in" for the
   token-first account backend (issue #135). Renders the auth screens (login,
   register, e-mail-verification landing, forgot/reset password), stores the
   access/refresh tokens, and boots the app in one of two modes:

   - Accounts mode (server has ACCOUNTS_ENABLED + SESSION_SECRET): the /api data
     routes require a valid account token, so the SPA shows the auth UI until the
     user logs in, then attaches the Bearer token to every request (via core.js
     api()) and refreshes it silently when it expires.
   - Legacy mode (accounts off — today's production, shared-password gate): every
     helper here is inert. probeMe() gets a 404, accountsMode stays false, and
     bootApp() just routes into the app exactly as before.

   Part of the frontend; all files share one global script scope. Loads right
   after core.js (uses h/esc/app/toast/openPopover) and before main.js (which
   calls bootApp last). See index.html for the load order. */

'use strict';

let accountsMode = false; // set by initAccounts(): true once the server confirms accounts are on
let accountUser = null; // { id, email, ... } when logged in; shown in the account menu

// Tokens live in localStorage so a reload stays logged in. Wrapped in try/catch
// because localStorage throws in some privacy modes — we degrade to "not logged
// in" rather than crashing the boot.
const SA_ACCESS = 'sa_access';
const SA_REFRESH = 'sa_refresh';
const saStore = () => { try { return window.localStorage; } catch { return null; } };
function getAccessToken() { try { const s = saStore(); return s ? s.getItem(SA_ACCESS) : null; } catch { return null; } }
function getRefreshToken() { try { const s = saStore(); return s ? s.getItem(SA_REFRESH) : null; } catch { return null; } }
function setTokens(access, refresh) {
  const s = saStore();
  if (!s) return;
  try { if (access) s.setItem(SA_ACCESS, access); if (refresh) s.setItem(SA_REFRESH, refresh); } catch {}
}
function clearTokens() {
  const s = saStore();
  if (!s) return;
  try { s.removeItem(SA_ACCESS); s.removeItem(SA_REFRESH); } catch {}
}

// Read by core.js api() and by the view code: which mode, and are we logged in.
function accountsActive() { return accountsMode; }
function isLoggedIn() { return accountsMode && !!getAccessToken(); }

// Auth endpoints are called with a plain fetch (not api()): they carry no Bearer
// token, and a 401 here means "bad credentials", not "session expired" — so they
// must NOT trigger the refresh-or-bounce logic api() adds.
async function authFetch(path, body) {
  const res = await fetch('/api/account' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data: data || {} };
}

// GET /me is the boot probe. 404 = accounts disabled (legacy mode); 401 = accounts
// on but not logged in; 200 = logged in (body is the user).
async function probeMe() {
  const token = getAccessToken();
  try {
    const r = await fetch('/api/account/me', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data: data || {} };
  } catch { return { status: 0, data: {} }; }
}

// Exchange the refresh token for a fresh pair (rotating). Returns whether it
// worked; on failure the (now useless) tokens are cleared. Called by core.js
// api() on a 401 before retrying the original request.
async function refreshAccessToken() {
  const refresh = getRefreshToken();
  if (!refresh) return false;
  try {
    const { ok, data } = await authFetch('/refresh', { refreshToken: refresh });
    if (ok && data.accessToken) { setTokens(data.accessToken, data.refreshToken); return true; }
  } catch {}
  clearTokens();
  return false;
}

// The session is unrecoverably gone (refresh failed): drop tokens and show login.
// Called by core.js api() when a 401 survives a refresh attempt.
function onSessionLost() {
  clearTokens();
  invalidateRoundCache(); // no cached round data may survive the identity loss
  accountUser = null;
  setupAccountUi();
  showLogin();
}

async function logout() {
  try { await authFetch('/logout', { refreshToken: getRefreshToken() }); } catch {}
  clearTokens();
  invalidateRoundCache(); // the next login may be a different account/tenant
  accountUser = null;
  setupAccountUi();
  showLogin();
}

/* --------------------------------- boot ----------------------------------- */

const isAuthPath = (p) => p === '/verify-email' || p === '/reset-password';

// Resolve the mode + login state, then decide the first screen. Called last from
// main.js so i18n/core/views are all loaded.
async function bootApp() {
  await initAccounts();
  const path = location.pathname;
  if (path === '/verify-email') return renderVerifyLanding();
  if (path === '/reset-password') return renderResetLanding();
  if (accountsActive() && !isLoggedIn()) return showLogin();
  authScreen(false);
  setupAccountUi();
  routeTo(path);
}

async function initAccounts() {
  const res = await probeMe();
  // Only a definitive answer from the (pre-gate) account router flips on accounts
  // mode: 200 = logged in, 401 = accounts on but not logged in. A 404 means
  // accounts are disabled, and anything else (a boot-time network hiccup) is
  // treated the same — legacy mode — so a transient error never strands a
  // shared-password instance on the login screen.
  if (res.status === 200) { accountsMode = true; accountUser = res.data; return; }
  if (res.status !== 401) { accountsMode = false; return; }
  accountsMode = true;
  if (getRefreshToken() && (await refreshAccessToken())) {
    const again = await probeMe(); // a stale access token: refreshed, probe again
    if (again.status === 200) { accountUser = again.data; return; }
  }
  clearTokens();
  accountUser = null;
}

// Enter the app after a successful login: leave the auth UI, reveal the account
// menu, and route to the deep link the user arrived on (or Home if that was an
// auth landing).
function enterApp() {
  authScreen(false);
  setupAccountUi();
  const path = location.pathname;
  routeTo(isAuthPath(path) ? '/' : path);
}

/* ------------------------------- auth screens ------------------------------ */

// Toggle the whole-screen auth layout: hides the top-bar home link and context
// label (the language picker stays) so a logged-out visitor sees only the auth
// card.
function authScreen(on) { document.body.classList.toggle('auth-screen', !!on); }

// Shared scaffold for an auth screen: clears the view, sets the auth layout, and
// appends the built card. `build(card)` wires the specific form. `render` is the
// function itself so a language switch re-renders it (via currentView).
function openAuth(render, innerHtml, build) {
  currentView = render;
  authScreen(true);
  setContext('');
  applyBackground(null);
  app.innerHTML = '';
  const wrap = h(`<div class="auth">${innerHtml}</div>`);
  app.appendChild(wrap);
  build(wrap.querySelector('.auth__card'));
}

const authError = (card) => card.querySelector('.auth__error');
function setError(card, msg) {
  const el = authError(card);
  el.textContent = msg;
  el.hidden = false;
}

function showLogin() {
  openAuth(showLogin, `<form class="auth__card" autocomplete="on">
      <div class="auth__logo"><i class="ti ti-tornado" aria-hidden="true"></i></div>
      <h1 class="auth__title">${esc(t('auth.login.title'))}</h1>
      <p class="auth__sub muted">${esc(t('auth.login.sub'))}</p>
      <div class="field">
        <label for="authEmail">${esc(t('auth.email'))}</label>
        <input id="authEmail" class="input" type="email" autocomplete="username" inputmode="email" />
      </div>
      <div class="field">
        <label for="authPassword">${esc(t('auth.password'))}</label>
        <input id="authPassword" class="input" type="password" autocomplete="current-password" />
      </div>
      <p class="auth__error" hidden></p>
      <button class="btn btn--primary btn--block" type="submit">${esc(t('auth.login.submit'))}</button>
      <div class="auth__links">
        <button class="link-btn" type="button" id="toForgot">${esc(t('auth.login.forgot'))}</button>
        <button class="link-btn" type="button" id="toRegister">${esc(t('auth.login.toRegister'))}</button>
      </div>
    </form>`, (card) => {
    const form = card.closest('.auth').querySelector('form');
    const email = card.querySelector('#authEmail');
    const pw = card.querySelector('#authPassword');
    const submit = card.querySelector('button[type=submit]');
    card.querySelector('#toForgot').addEventListener('click', showForgot);
    card.querySelector('#toRegister').addEventListener('click', showRegister);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      authError(card).hidden = true;
      if (!email.value.trim() || !pw.value) return setError(card, t('auth.error.missing'));
      submit.disabled = true;
      try {
        const { ok, status, data } = await authFetch('/login', { email: email.value.trim(), password: pw.value });
        if (ok) {
          setTokens(data.accessToken, data.refreshToken);
          // A different account than the cache's owner may be logging in on
          // this browser — its persisted round data must not leak across.
          invalidateRoundCache();
          accountUser = data.user || null;
          enterApp();
          return;
        }
        setError(card, status === 403 && data.error === 'email_not_verified'
          ? t('auth.error.notVerified') : t('auth.error.badCredentials'));
      } catch { setError(card, t('auth.error.network')); }
      submit.disabled = false;
    });
    email.focus();
  });
}

function showRegister() {
  openAuth(showRegister, `<form class="auth__card" autocomplete="on">
      <div class="auth__logo"><i class="ti ti-tornado" aria-hidden="true"></i></div>
      <h1 class="auth__title">${esc(t('auth.register.title'))}</h1>
      <p class="auth__sub muted">${esc(t('auth.register.sub'))}</p>
      <div class="field">
        <label for="regEmail">${esc(t('auth.email'))}</label>
        <input id="regEmail" class="input" type="email" autocomplete="username" inputmode="email" />
      </div>
      <div class="field">
        <label for="regUser">${esc(t('auth.username'))}</label>
        <!-- 'nickname', NOT 'username': login authenticates by E-MAIL, and the
             login form's address field owns autocomplete="username". Claiming
             that token here would make a password manager store the handle as
             the credential's username and then autofill it into the login
             e-mail box on the next visit. -->
        <input id="regUser" class="input" type="text" autocomplete="nickname"
               maxlength="30" spellcheck="false" autocapitalize="none" />
        <div class="field__hint muted">${esc(t('auth.register.userHint'))}</div>
      </div>
      <div class="field">
        <label for="regPw">${esc(t('auth.password'))}</label>
        <input id="regPw" class="input" type="password" autocomplete="new-password" />
        <div class="field__hint muted">${esc(t('auth.register.pwHint'))}</div>
      </div>
      <p class="auth__error" hidden></p>
      <button class="btn btn--primary btn--block" type="submit">${esc(t('auth.register.submit'))}</button>
      <p class="auth__terms muted">${esc(t('auth.register.termsPre'))}
        <a href="/nutzungsbedingungen" target="_blank" rel="noopener">${esc(t('auth.register.termsLinkLabel'))}</a>.
        ${esc(t('auth.register.privacyPre'))}
        <a href="/datenschutz" target="_blank" rel="noopener">${esc(t('auth.register.privacyLinkLabel'))}</a>.</p>
      <div class="auth__links">
        <button class="link-btn" type="button" id="toLogin">${esc(t('auth.register.toLogin'))}</button>
      </div>
    </form>`, (card) => {
    const form = card.closest('.auth').querySelector('form');
    const email = card.querySelector('#regEmail');
    const user = card.querySelector('#regUser');
    const pw = card.querySelector('#regPw');
    const submit = card.querySelector('button[type=submit]');
    card.querySelector('#toLogin').addEventListener('click', showLogin);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      authError(card).hidden = true;
      const username = user.value.trim();
      if (!email.value.trim() || !username) return setError(card, t('auth.error.missing'));
      // Mirrors usernameSchema in routes/account.js — the server is still the
      // authority; this only saves a round trip on an obviously bad handle.
      if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) return setError(card, t('auth.error.invalidUsername'));
      if (pw.value.length < 8) return setError(card, t('auth.error.shortPassword'));
      submit.disabled = true;
      try {
        const { ok, data } = await authFetch('/register', { email: email.value.trim(), username, password: pw.value });
        // Register answers ok even for an existing e-mail (anti-enumeration) — a
        // 400/409 only comes back for a malformed field or a taken username,
        // which IS reported openly (a public handle; see routes/account.js).
        if (ok) return showAuthDone('auth.register.doneTitle', 'auth.register.doneSub');
        const messages = {
          invalid_email: 'auth.error.invalidEmail',
          invalid_username: 'auth.error.invalidUsername',
          username_taken: 'auth.error.usernameTaken',
        };
        setError(card, t(messages[data.error] || 'auth.error.shortPassword'));
      } catch { setError(card, t('auth.error.network')); }
      submit.disabled = false;
    });
    email.focus();
  });
}

function showForgot() {
  openAuth(showForgot, `<form class="auth__card" autocomplete="on">
      <div class="auth__logo"><i class="ti ti-lock-question" aria-hidden="true"></i></div>
      <h1 class="auth__title">${esc(t('auth.forgot.title'))}</h1>
      <p class="auth__sub muted">${esc(t('auth.forgot.sub'))}</p>
      <div class="field">
        <label for="fpEmail">${esc(t('auth.email'))}</label>
        <input id="fpEmail" class="input" type="email" autocomplete="username" inputmode="email" />
      </div>
      <p class="auth__error" hidden></p>
      <button class="btn btn--primary btn--block" type="submit">${esc(t('auth.forgot.submit'))}</button>
      <div class="auth__links">
        <button class="link-btn" type="button" id="toLogin">${esc(t('auth.backToLogin'))}</button>
      </div>
    </form>`, (card) => {
    const form = card.closest('.auth').querySelector('form');
    const email = card.querySelector('#fpEmail');
    const submit = card.querySelector('button[type=submit]');
    card.querySelector('#toLogin').addEventListener('click', showLogin);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      authError(card).hidden = true;
      if (!email.value.trim()) return setError(card, t('auth.error.missing'));
      submit.disabled = true;
      // Always answers ok (anti-enumeration) — show the same confirmation either way.
      try { await authFetch('/forgot-password', { email: email.value.trim() }); } catch {}
      showAuthDone('auth.forgot.doneTitle', 'auth.forgot.doneSub');
    });
    email.focus();
  });
}

// A terminal "check your e-mail" style panel (after register / forgot-password),
// with a single way back to login.
function showAuthDone(titleKey, subKey) {
  openAuth(() => showAuthDone(titleKey, subKey), `<div class="auth__card">
      <div class="auth__logo"><i class="ti ti-mail-check" aria-hidden="true"></i></div>
      <h1 class="auth__title">${esc(t(titleKey))}</h1>
      <p class="auth__sub muted">${esc(t(subKey))}</p>
      <button class="btn btn--primary btn--block" type="button" id="toLogin">${esc(t('auth.backToLogin'))}</button>
    </div>`, (card) => {
    card.querySelector('#toLogin').addEventListener('click', showLogin);
  });
}

// Landing for the e-mail-verification link (/verify-email?uid&token): POST the
// token, then show success/failure with a button to login.
function renderVerifyLanding() {
  const params = new URLSearchParams(location.search);
  const uid = params.get('uid');
  const token = params.get('token');
  openAuth(renderVerifyLanding, `<div class="auth__card">
      <div class="auth__logo"><i class="ti ti-mail-check" aria-hidden="true"></i></div>
      <h1 class="auth__title">${esc(t('auth.verify.working'))}</h1>
      <p class="auth__sub muted" id="verifyMsg">…</p>
      <button class="btn btn--primary btn--block" type="button" id="toLogin" hidden></button>
    </div>`, (card) => {
    const toLogin = card.querySelector('#toLogin');
    toLogin.addEventListener('click', showLogin);
    (async () => {
      const { ok } = uid && token ? await authFetch('/verify-email', { uid, token }) : { ok: false };
      card.querySelector('.auth__title').textContent = t(ok ? 'auth.verify.okTitle' : 'auth.verify.failTitle');
      card.querySelector('#verifyMsg').textContent = t(ok ? 'auth.verify.okSub' : 'auth.verify.failSub');
      toLogin.textContent = t('auth.backToLogin');
      toLogin.hidden = false;
    })();
  });
}

// Landing for the password-reset link (/reset-password?uid&token): a new-password
// form that posts the token.
function renderResetLanding() {
  const params = new URLSearchParams(location.search);
  const uid = params.get('uid');
  const token = params.get('token');
  openAuth(renderResetLanding, `<form class="auth__card" autocomplete="on">
      <div class="auth__logo"><i class="ti ti-lock" aria-hidden="true"></i></div>
      <h1 class="auth__title">${esc(t('auth.reset.title'))}</h1>
      <p class="auth__sub muted">${esc(t('auth.reset.sub'))}</p>
      <div class="field">
        <label for="resetPw">${esc(t('auth.reset.newPassword'))}</label>
        <input id="resetPw" class="input" type="password" autocomplete="new-password" />
      </div>
      <p class="auth__error" hidden></p>
      <button class="btn btn--primary btn--block" type="submit">${esc(t('auth.reset.submit'))}</button>
      <div class="auth__links">
        <button class="link-btn" type="button" id="toLogin">${esc(t('auth.backToLogin'))}</button>
      </div>
    </form>`, (card) => {
    const form = card.closest('.auth').querySelector('form');
    const pw = card.querySelector('#resetPw');
    const submit = card.querySelector('button[type=submit]');
    card.querySelector('#toLogin').addEventListener('click', showLogin);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      authError(card).hidden = true;
      if (pw.value.length < 8) return setError(card, t('auth.error.shortPassword'));
      submit.disabled = true;
      const { ok } = uid && token ? await authFetch('/reset-password', { uid, token, password: pw.value }) : { ok: false };
      if (ok) { toast(t('auth.reset.done')); return showLogin(); }
      setError(card, t('auth.reset.invalid'));
      submit.disabled = false;
    });
    pw.focus();
  });
}

/* ----------------------------- top-bar account ----------------------------- */

// Reveal (accounts mode + logged in) or hide the top-bar account button, and wire
// its menu (e-mail + logout). Called on boot, login, and logout.
function setupAccountUi() {
  const btn = document.getElementById('accountBtn');
  if (!btn) return;
  const loggedIn = accountsActive() && isLoggedIn();
  btn.hidden = !loggedIn;
  if (!loggedIn) return;
  btn.onclick = () => openPopover(btn, (el, close) => {
    const username = (accountUser && accountUser.username) || '';
    el.appendChild(h(`<div class="popover__head">${
      username ? `<strong>${esc(username)}</strong>` : ''
    }${esc((accountUser && accountUser.email) || '')}</div>`));
    const out = h(`<button class="popover__opt"><i class="ti ti-logout" aria-hidden="true"></i> ${esc(t('auth.logout'))}</button>`);
    out.addEventListener('click', () => { close(); logout(); });
    el.appendChild(out);
  });
}
