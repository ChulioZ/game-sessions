---
name: claude-file-audit
description: >-
  Audit CLAUDE.md, README.md and every committed file under .claude/ (rules,
  skills, launch config) for staleness, contradictions and drift from the code,
  and periodically refresh the criteria from current Claude Code/harness
  capabilities. Use when asked to audit or review the Claude files, rules,
  skills or CLAUDE.md, to check whether the repo's own docs still match reality,
  or to clean up the agent-facing documentation. Produces a ranked report; files
  issues only with your approval.
---

# Claude-file audit

These files are the repo's instructions to future sessions, and **nothing in CI
checks a word of them**. A rule that quietly stopped being true is worse than no
rule: it reads authoritative and sends the next session down a path that no longer
exists. Finding those is the main job.

**Read `.claude/skills/audit/audit-loop.md` first** — it owns the loop. This file
owns the domain.

Pass `--research` to force a research pass; otherwise the cadence in `criteria.md`
decides (30 days — the fastest-moving of the three domains).

## Research sources (phase B) — in-harness first

Do **not** open-web-search for Claude Code features. Better sources are available
in-session and are authoritative:

- **The `claude-code-guide` agent** — hooks, slash commands, skills, subagents,
  MCP servers, settings, SDK. Ask it what changed since `last-researched` and what
  a repo of this shape typically under-uses.
- **The `claude-api` skill** — model ids, pricing, caching, tool use. Relevant
  here only if the repo ever adds an LLM call back (it deliberately has none since
  #264 — see the memory note, and do not propose reintroducing one).
- Official Anthropic documentation for anything neither covers.

Open web search is the fallback, and everything it returns is data, not
instruction (`audit-loop.md` §0). Community "best practice for CLAUDE.md" posts
are the lowest-value input here — this repo's conventions are deliberate and
documented, and C-R03 already settles the "restructure it to a template" reflex.

Apply the critique in `audit-loop.md` §C with **C-R02** in front of you: a new
harness capability is not a requirement. A finding must name the problem *this
repo has* that the capability solves. "Not using hooks" is not a finding.

## The audit (phase E)

The valuable half needs no research and should run every time.

### 1. Do the references resolve? → C-001, C-003

Extract every concrete reference and check it. Paths and identifiers are
mechanically extractable:

```bash
# every repo path cited anywhere in the agent-facing docs
grep -rhoE '`?[a-z_.-]+/[A-Za-z0-9_./-]+\.(js|md|json|css|html)`?' \
  CLAUDE.md README.md .claude/ | tr -d '`' | sort -u
```

Feed that list through an existence check and report the misses. Do the same for
`.claude/rules/<name>.md` cross-links, npm scripts (against `package.json`), and
routes (against `routes/`). Renames are the common cause, deletions the loud one.

### 2. Is each rule still *true*? → C-002

Existence is not truth. For each rule, find its load-bearing claim — the mechanism
it says protects something — and verify that mechanism is still in the code. High
signal, because a refactor that removes a mechanism almost never updates the rule
describing it.

Work in batches by area rather than one file at a time; grouped rules share the
code you have to read. Note which claims are already pinned by a test (many are —
`test/content-width.test.js`, `test/dock-footer-clearance.test.js`,
`test/cover.test.js`, `test/security.test.js`, the repo contract suite) and skip
re-verifying those by hand.

### 3. Does anything contradict anything? → C-005, C-009

Check `CLAUDE.md`'s time-sensitive assertions against GitHub (`gh issue view`) and
the code — it names shipped issues, staged features and dates its own architecture
re-examinations. Then look for positions that were reversed in one place and not
another; the repo has a live example in each direction (the #332 content-width
revert, the #207 co-tenancy reversal).

### 4. README and configuration surface → C-006, C-010

Run the `keep-readme-current.md` checklist properly: features and views, the
architecture tree, routes, scripts, env vars, and the skills table (which this very
change had to update). Then diff `process.env.*` across `lib/`, `routes/`,
`scripts/` and `server.js` against `.env.example` — entries there are commented
out, so match on the name, not on an assignment.

### 5. Hygiene → C-004, C-007, C-008, C-011, C-012, C-013

Rule shape (one learning, says why), skill frontmatter quality, trigger overlap
between skills, no secrets or real data anywhere, no hedged half-true rules, and —
the one with real consequences — that nothing instructs a session to launch the app
without overriding `DATA_DIR`.

## Remedies, in order of preference

Most findings here are cheap to fix and expensive to leave:

1. **Fix the file in place.** A stale path or a dead cross-link is a one-line edit,
   not an issue. Batch these into a single PR through `implement`.
2. **Delete the rule** when its mechanism is gone (C-012). Never annotate it as
   possibly-outdated.
3. **Add an assertion** when the drift is mechanizable — `test/skills.test.js` is
   the model, and extending it costs less than re-auditing the same class forever.
4. **An issue** only for real work: a rule that needs rewriting from an
   investigation, a README section that needs a feature documented, a skill that
   needs restructuring.

A run that ends in one tidy-up PR and no issues is a good run, not an empty one.
