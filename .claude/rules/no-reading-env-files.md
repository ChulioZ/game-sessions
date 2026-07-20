# Never read local environment files

Local env files — `.env`, `.env.local`, `.env.*.local`, or any file the running
process loads via `--env-file` / `--env-file-if-exists` — hold **secrets**, in
particular `SESSION_SECRET` (which signs account access tokens), `DATABASE_URL`,
and the S3/Brevo credentials. They are gitignored precisely so they never leave
this machine.

**Rule:** agents must **not** read, open, `cat`, `grep`, copy, print, or
otherwise inspect the contents of these env files. Treat them as strictly
off-limits. Never paste their contents — or any value read from them — into
responses, commits, logs, screenshots, or anywhere else. Do not echo
`process.env.SESSION_SECRET` (or any other secret env var) either.

- The committed **`.env.example`** is safe to read and edit — it is a template
  with placeholders and **no real secrets**. Keep it in sync when you add or
  rename an env var (see `.claude/rules/keep-readme-current.md` for the sibling
  README check).
- You may reference *which* env vars exist and what they do from the code
  (`lib/store.js`, `lib/accounts.js`, `lib/mail.js`, the providers) and from
  `.env.example` — never from a real `.env`.
- Structural, non-content operations that don't reveal a value are fine when
  needed (e.g. checking whether `.env` exists). If a task seems to *require*
  reading a real secret, stop and ask the user instead — never read it yourself.

**Why:** these files exist to keep credentials local and unseen. An agent
reading one (and possibly echoing it into a transcript, a commit, or a
screenshot) would leak a live, billable API key. The code never needs an agent
to look inside `.env` to work on it — the variable names and meanings are fully
described by the code and `.env.example`. This mirrors
`.claude/rules/no-reading-production-data.md` for the `data/` directory.
