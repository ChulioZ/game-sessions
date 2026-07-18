# Accounts mode: the /api + /uploads gate and the SPA shell (issue #138)

Issue #138 built the onboarding/auth UI and flipped the app between two auth
modes. `accounts.accountsEnabled()` (ACCOUNTS_ENABLED + SESSION_SECRET) is the
switch, read per request in `lib/app.js`. Non-obvious things, keep them:

- **`/api` is Bearer-ONLY in accounts mode; `/uploads` also accepts a cookie.**
  `lib/app.js` wires two accounts-aware gates:
  - `/api` → `accounts.requireApiAccount`: a valid **Authorization: Bearer**
    access token is required (401 `auth_required` otherwise). The cookie is
    deliberately **not** honored here, so a cross-site form can't attach a header
    and the state-changing data routes stay CSRF-immune.
  - `/uploads` → `accounts.requireUploadAccount`: Bearer **or** the `sa` access
    cookie. Cover images render as `background-image`/`<img>`, which can't send a
    header — so login/refresh mirror the access token into a `sameSite=lax`,
    httpOnly cookie (`accounts.setAccessCookie`). Lax + read-only GET = no CSRF
    exposure (a cross-site subresource can't ride a lax cookie).
  When accounts are **off**, both gates fall back to `auth.requireAuth` (the
  shared-password gate, itself a no-op when AUTH_PASSWORD is unset) — production
  is byte-for-byte unchanged. Don't collapse the two gates into one "Bearer or
  cookie" gate: that would let the cookie authenticate `/api` and reintroduce CSRF.

- **The cookie is short-lived and self-healing.** Its maxAge is the 15-min access
  TTL; every `/refresh` re-sets it. So a cover load right after the token expires
  can 401 (blank cover) until the next `/api` call refreshes and re-sets the
  cookie. That's an accepted limitation (accounts mode is off in prod, and a
  brand-new onboarding account has no covers yet). Per-tenant `/uploads` isolation
  is still follow-up (#207/#137) — today any valid account passes the uploads gate.

- **In accounts mode the SPA shell is ALWAYS served** (never `login.html`). The
  fallback in `lib/app.js` short-circuits to `index.html` so the client can render
  the auth UI; the data routes above stay token-gated, so an unauthenticated
  visitor still gets no round data. `login.html` is only for the legacy
  shared-password gate.

- **Frontend detects the mode via `GET /api/account/me`** (mounted before the
  gate). `initAccounts()` (public/js/account.js) treats **404** = accounts off
  (legacy mode, everything inert), **401** = accounts on, not logged in,
  **200** = logged in. Only a definitive 200/401 flips on accounts mode — a
  boot-time network error falls back to legacy, so a shared-password instance is
  never stranded on the login screen.

- **`core.js api()` is the token chokepoint.** It attaches the Bearer header when
  `getAccessToken()` is non-null (no-op in legacy mode) and, on a 401
  `auth_required` in accounts mode, does ONE silent `refreshAccessToken()` +
  retry, then `onSessionLost()` (→ login). Legacy mode keeps the old
  `window.location.assign('/')` bounce. The account helpers live in the
  later-loaded `account.js` but are only referenced at call time, so the load
  order (core → account → main) is safe — see frontend-script-load-order.md.

- **What #138 did NOT do:** invitations / tenant-sharing (a second user can't see
  your rounds under RLS — that's #207) and roles (#137). Enabling accounts in
  production is a deliberate ops step, not something this code turns on.
