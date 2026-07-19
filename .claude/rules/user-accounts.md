# The user-account layer (lib/accounts.js, routes/account.js) — gotchas

Issue #135 added the token-first account model (register / e-mail verification /
login / rotating refresh tokens / password reset) that will eventually replace
the shared-password gate. Things that will bite if you forget them:

- **The feature is double-gated: `ACCOUNTS_ENABLED=true` AND a non-empty
  `SESSION_SECRET`.** Without both, every /api/account handler 404s
  (`accounts_disabled`). The secret requirement is not bureaucracy: access
  tokens are HS256 JWTs signed with SESSION_SECRET (via `jsonwebtoken`, #214),
  and unlike lib/auth.js it must
  NOT fall back to AUTH_PASSWORD — the shared password is known to the whole
  group, so falling back would let any group member forge any user's tokens.
  Enabling accounts in production is still a deliberate ops step (not
  automatic just because the code supports it — see accounts-mode-gate.md),
  but the earlier reason to hold off is gone: onboarding (#138) shipped
  2026-07-19, so there's now a real UI that sends the Bearer token, and
  tenancy (#136) scopes /api data per registration. Tenant-*sharing*
  (invites/#207) is **not** a prerequisite for opening registration — a
  single-owner tenant with name-only members (today's model) is a complete
  product on its own; see the 2026-07-19 note on #207 and
  docs/production-readiness.md §12 Phase 4.

- **Coexistence, not replacement (yet).** lib/auth.js (shared gate) still
  protects the instance's data; /api/account mounts *before* the gate (like
  /api/auth) behind the same AUTH_RATE_LIMIT_MAX limiter. test/helpers.js
  raises that ceiling for the shared test app — an account-flow test making
  >20 requests would otherwise flake with 429s (see security-middleware.md).

- **User objects keep every key present (null when unset).** `verification`,
  `reset`, `refreshTokens`, `emailVerified` are always written, because the
  Postgres backend's jsonb round-trip must match the JSON backend exactly
  (absent-key parity, see postgres-backend.md). `updateUser` replaces whole
  top-level keys (jsonb `||` semantics = Object.assign) — always pass complete
  arrays (identities, refreshTokens), never a partial "append".

- **Only hashes at rest.** Passwords → Argon2id (`argon2`, a native prod
  dependency with bundled prebuilds — no compiler needed in Docker/CI);
  refresh/verify/reset tokens → SHA-256. The raw refresh token embeds the user
  id ("r1.<uid>.<random>") so the API stays `{ refreshToken }`-only without a
  token→user index. Anti-enumeration invariants the tests assert: register and
  forgot-password answer identically for known/unknown e-mails; login burns
  the same Argon2 work via a dummy hash when the account doesn't exist.

- **Mail (lib/mail.js) degrades by design.** No BREVO_API_KEY → messages go to
  the in-memory `outbox` (tests read tokens out of it — never set a real key
  in tests; stub `fetch` for the Brevo path). Account routes wrap sends in
  `sendSafe`: a mail failure logs but never 500s the flow.

- **`data.users` is top-level in data.json** (a sibling of `rounds`, defaulted
  by lib/store.js loadData) and a `users` table in Postgres with a UNIQUE
  expression index on `data->>'email'` — `createUser` maps error 23505 to
  `'email_taken'`. The JSON→Postgres migration imports users via
  `repo.importUsers` (id-preserving, both backends, contract-tested).
