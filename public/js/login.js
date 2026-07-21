'use strict';

/*
 * Standalone login page script (issue #129). NOT part of the SPA's shared global
 * scope — wrapped in an IIFE so it declares no top-level names and needs no entry
 * in eslint.config.js's frontendGlobals. On success it navigates to '/', which
 * the server now serves the app shell for once the session cookie is set.
 */
(function () {
  const form = document.getElementById('loginForm');
  const input = document.getElementById('password');
  const errorEl = document.getElementById('error');
  const button = form.querySelector('button');

  // Kontakt link (issue #224): shown only when the server reports the public
  // footer surfaces as configured — same gate as the SPA footer (core.js
  // initFooter). On any error it just stays hidden.
  fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (cfg && cfg.footer) document.getElementById('footKontakt').hidden = false;
    })
    .catch(() => {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    button.disabled = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
      });
      if (res.ok) {
        window.location.assign('/');
        return;
      }
    } catch {
      /* fall through to the error message */
    }
    errorEl.hidden = false;
    button.disabled = false;
    input.select();
  });
})();
