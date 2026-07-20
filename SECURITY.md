# Security Policy

## Project stage

This app runs **live in production** (Railway, managed PostgreSQL, TLS — see
[`docs/deploy-railway.md`](docs/deploy-railway.md)), gated behind a
shared-password login and/or a token-first account model with per-tenant data
isolation ([`CLAUDE.md`](CLAUDE.md), [`.claude/rules/tenancy-rls.md`](.claude/rules/tenancy-rls.md)).
**Public self-registration is not open yet** — `ACCOUNTS_ENABLED` is a
deliberate ops switch the maintainer hasn't flipped in production, pending the
legal pack (see `docs/production-readiness.md` §9, §12). A bare local checkout
still defaults to no authentication (same as any self-hosted instance you run
without setting `AUTH_PASSWORD`) — that default is documented, not a bug, and
is expected to run on a trusted network if left as-is.

Please keep this context in mind when assessing severity: reports assuming a
still-local-only, un-hosted MVP no longer apply — treat this as a real,
internet-facing production service with real (if not-yet-public) user data.

Security issues especially relevant given the current architecture:

- **Cross-tenant data leakage** — one account/tenant seeing another's rounds,
  members, games, sessions, or cover images (see
  [`.claude/rules/tenancy-rls.md`](.claude/rules/tenancy-rls.md)).
- Auth/session bypass — forging or replaying access/refresh tokens, the shared
  session cookie, or the `/uploads` cookie gate (see
  [`.claude/rules/accounts-mode-gate.md`](.claude/rules/accounts-mode-gate.md),
  [`.claude/rules/user-accounts.md`](.claude/rules/user-accounts.md)).
- Ways to read or write files outside the app's data directory (path
  traversal), including via the S3-compatible object-storage backend.
- Server-side request forgery (SSRF) through the cover-image download or the
  add-game lookup providers.
- Injection or remote code execution reachable from a request (including SQL
  injection against the Postgres backend).
- Leaking secrets (`SESSION_SECRET`, `DATABASE_URL`, S3/Brevo credentials) or
  another tenant's private data.
- Dependency vulnerabilities with a realistic exploitation path here.

## Supported versions

There are no tagged releases. Only the current `main` branch is supported; fixes
land there.

## Reporting a vulnerability

**Please report privately — do not open a public issue for a security problem.**

Use GitHub's **private vulnerability reporting**: go to the repository's
**Security** tab and click **"Report a vulnerability"**
([Security Advisories](https://github.com/ChulioZ/spielwirbel/security/advisories/new)).
This opens a private advisory visible only to you and the maintainers.

When reporting, please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof of concept if possible),
- the affected file(s), route(s), or dependency, and
- any suggested fix or mitigation you have in mind.

This is a hobby project maintained in spare time, so responses are best-effort
rather than on a fixed SLA. We will acknowledge your report, work with you to
confirm and fix the issue, and credit you in the fix if you would like.
