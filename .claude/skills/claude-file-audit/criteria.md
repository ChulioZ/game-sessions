# Claude-file criteria

- **last-researched:** never
- **cadence:** 30 days

Seeded 2026-07-23 from `CLAUDE.md` (the "Capturing learnings" contract),
`.claude/rules/keep-readme-current.md` and
`.claude/rules/token-friendly-source-files.md` — **not** from research.

Scope: `CLAUDE.md`, `README.md`, and everything committed under `.claude/`
(49 rule files, the skills, `launch.json`).

**The premise:** these files are *instructions to future sessions*. A stale one is
worse than a missing one — it actively misdirects, and nothing in CI checks any of
it. So the highest-value criteria here are staleness checks, and they need no
research at all.

---

### C-001 — Every concrete reference resolves
- **Status:** adopted · 2026-07-23
- **Source:** the premise above
- **Check:** Every file path, function name, `const`, env var, route, npm script, table,
  column, migration and test name quoted in `CLAUDE.md`, `README.md` or a `.claude/**`
  file still exists in the code. Mechanically extractable: paths look like
  `lib/…`, `public/js/…`, `test/….js`, `.claude/rules/….md`; identifiers appear in
  backticks. A reference that has been renamed is the common case, not a deleted one.
- **Enforced by:** `test/skills.test.js` (rule/test/doc paths cited by skill files)

### C-002 — Each rule's load-bearing claim is still true
- **Status:** adopted · 2026-07-23
- **Source:** the premise above
- **Check:** Every rule exists to prevent a specific symptom. Spot-check that claim
  against the code, not just that the file it names exists — e.g. does `trackEvent` still
  drop unknown fields, does `storage.remove()` still ignore non-`/uploads/` paths, is the
  860/859 media-query adjacency still there, does `TENANT_METHODS` still exclude the
  moderation methods. A rule whose mechanism was refactored away is the worst case: it
  reads authoritative and describes nothing.
- **Enforced by:** — (manual; many are pinned by their own tests — note which)

### C-003 — Cross-links resolve
- **Status:** adopted · 2026-07-23
- **Source:** `token-friendly-source-files.md`
- **Check:** Every `Related:` pointer and every inline `.claude/rules/<name>.md` mention
  names a file that exists. Rules reference each other heavily; a dangling pointer costs a
  future session a search that returns nothing.
- **Enforced by:** `test/skills.test.js` (skill files) — rule-to-rule links are manual

### C-004 — One learning per rule file, short, and it says *why*
- **Status:** adopted · 2026-07-23
- **Source:** `CLAUDE.md` → "Capturing learnings → `.claude/rules/`"
- **Check:** A rule states what the rule is *and* the symptom or trap it prevents. Flag
  files that have grown into several unrelated learnings (split them), that describe
  *what* the code does without saying why it matters, or that document something already
  obvious from the code.
- **Enforced by:** — (manual)

### C-005 — Nothing contradicts anything
- **Status:** adopted · 2026-07-23
- **Source:** the premise above
- **Check:** Rule against rule, rule against `CLAUDE.md`, skill against rule, and
  `README.md` against all of them. Contradictions arrive by accretion: a decision gets
  reversed in one file and the other keeps the old position (the #332 width revert and the
  #207 co-tenancy reversal are both live examples of the shape).
- **Enforced by:** — (manual)

### C-006 — README reflects the shipped app
- **Status:** adopted · 2026-07-23
- **Source:** `keep-readme-current.md`
- **Check:** Features and views, the architecture tree, API routes, npm scripts, env vars,
  Node/runtime requirements, and the skills table. The README drifted wholesale once
  before (it described the pre-redesign app months after the redesign shipped), which is
  why that rule exists.
- **Enforced by:** — (manual)

### C-007 — Every skill has frontmatter that will actually trigger it
- **Status:** adopted · 2026-07-23
- **Source:** skill-authoring conventions
- **Check:** `name` matches the directory; `description` says both **what it does** and
  **when to use it**, in the words a user would actually type, and names what it is *not*
  for when a sibling skill is the better match. A description that only describes the
  skill's mechanics never fires.
- **Enforced by:** `test/skills.test.js` (presence, `name`↔directory, non-empty description)

### C-008 — Skills compose rather than overlap
- **Status:** adopted · 2026-07-23
- **Source:** the existing pipeline (`create-issue` → `pick-issue` → `implement` →
  `review-pr`)
- **Check:** Each skill names its handoffs, and no two claim the same trigger space. Two
  skills that both plausibly answer "review this" is a routing failure, not redundancy.
- **Enforced by:** — (manual)

### C-009 — `CLAUDE.md` states the current stage accurately
- **Status:** adopted · 2026-07-23
- **Source:** `CLAUDE.md` header
- **Check:** It asserts time-sensitive facts — production status, which issues shipped,
  which architecture calls were re-examined and when, what is staged behind
  `ACCOUNTS_ENABLED`. Verify each against GitHub and the code. These are the first claims
  a new session reads and the ones most likely to have quietly expired.
- **Enforced by:** — (manual)

### C-010 — `.env.example` matches the env vars the code reads
- **Status:** adopted · 2026-07-23
- **Source:** `no-reading-env-files.md`
- **Check:** Extract `process.env.X` across `lib/`, `routes/`, `scripts/`, `server.js` and
  diff against the (commented-out) entries in `.env.example`. It is the only sanctioned
  description of the app's configuration surface, since the real `.env` is unreadable.
- **Enforced by:** — (manual)

### C-011 — No secret, credential or production data in any committed Claude file
- **Status:** adopted · 2026-07-23
- **Source:** `no-reading-env-files.md`, `no-reading-production-data.md`
- **Check:** No real tokens, connection strings, addresses, e-mails or excerpts of real
  round/member data in `CLAUDE.md`, `README.md` or `.claude/**`. Rules quote code and
  measured numbers — that is fine; they must never quote data.
- **Enforced by:** gitleaks in CI (credentials) — data excerpts are manual

### C-012 — A rule that became wrong is removed, not left standing
- **Status:** adopted · 2026-07-23
- **Source:** `CLAUDE.md` ("update or remove a rule if it becomes wrong")
- **Check:** When C-002 finds a rule whose mechanism is gone, the remedy is deletion or a
  rewrite — never a "note: possibly outdated" line. A hedged rule is unusable: the next
  session cannot tell which half to trust. Historical notes are fine when explicitly
  framed as history (the monthly-window note in `per-tenant-quotas.md` is the model).
- **Enforced by:** — (manual)

### C-013 — Anything that launches the app overrides `DATA_DIR`
- **Status:** adopted · 2026-07-23
- **Source:** `no-reading-production-data.md`
- **Check:** `.claude/launch.json` points at the production `data/` folder by design. So
  every skill, rule or doc that tells a session to start the app for verification must say
  to override `DATA_DIR` to a temp folder first. A skill that says "run `npm start` and
  screenshot it" is a data-leak instruction.
- **Enforced by:** — (manual)

---

## Rejected — settled, do not re-litigate

### C-R01 — "Consolidate the rule files into one document"
- **Status:** rejected · 2026-07-23
- **Why:** Directly contradicts `CLAUDE.md`'s one-learning-per-file contract and
  `token-friendly-source-files.md`. The point of many small files is that a session loads
  only the two it needs; one large file is loaded whole for every change. The count (49)
  is not itself a problem — an unfindable or stale rule is, and C-001/C-002 target that.

### C-R02 — "Adopt harness feature X because it exists"
- **Status:** rejected · 2026-07-23 — **meta-criterion**
- **Why:** A new hook type, agent kind, settings key or output style is a *capability*,
  not a requirement. It becomes a criterion only when it solves a problem this repo
  actually has, and the research phase must name that problem. Otherwise the criteria list
  grows into a feature checklist and every audit reports "not using X" as a violation.

### C-R03 — "Restructure `CLAUDE.md` to a standard template"
- **Status:** rejected · 2026-07-23
- **Why:** Its current shape (stage → architecture calls with their reasoning → i18n →
  conventions → running/verifying → the learnings contract) is load-bearing: the
  architecture section records *why* each call was made and when it was last re-examined,
  which a generic template drops. Reorganise only for a defect that costs a session real
  effort, and say what that defect was.
