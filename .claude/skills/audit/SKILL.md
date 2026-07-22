---
name: audit
description: >-
  Run the full audit sweep — accessibility, legal, and Claude-file — in one pass
  and merge the results into a single ranked report with one approval step. Use
  when asked to audit the app/project/repo generally, for a health check or
  compliance sweep, before a release or before opening public registration, or
  when more than one of the three domains is wanted. For a single domain, invoke
  accessibility-audit, legal-audit or claude-file-audit directly.
---

# Full audit

A thin orchestrator over the three domain audits. It exists so the user reviews
**one** ranked list and approves **one** batch of issues, instead of three of each.

It adds no criteria of its own. Every judgement lives in the domain skills and
`audit-loop.md`; this file only decides what runs where, and how the results
merge.

## Run order — and why it is not "all three in parallel"

- **`legal-audit` and `claude-file-audit` run as two parallel subagents.** They
  are independent, sizeable, read-only sweeps over disjoint file sets — exactly
  the case parallel subagents are for. Launch both in a single message.
- **`accessibility-audit` runs in the main agent, on its own.** It drives the
  Browser pane, and **there is one pane per session** — a subagent driving it
  while anything else does would contend for the same tabs. It also needs a temp
  `DATA_DIR`, a throwaway `launch.json` entry and a preview server, so keeping it
  in the main agent keeps that setup and its cleanup in one place.

Start the two subagents first, then do the accessibility pass yourself while they
work. Collect their reports when they land.

## Briefing the subagents

Each subagent starts cold, so brief it completely the first time — a re-brief
costs another full context load. Each brief must carry:

- The skill to invoke (`legal-audit` / `claude-file-audit`) and that it must read
  `.claude/skills/audit/audit-loop.md` and its own `criteria.md` first.
- Whether research is in scope this run (pass `--research` through, or say
  "cadence decides").
- **Report only — file nothing, open no PR, change no file.** The merge, the
  approval and every write happen here. A subagent that files issues on its own
  defeats the single-approval design.
- The report shape from `audit-loop.md` §F: criterion id, evidence, severity,
  cheapest correct remedy.

## Merging

1. **Dedupe across domains.** The three overlap by design at a few seams — the
   EAA/BFSG applicability question is recorded in both `accessibility-audit`
   (A-R05, deferred) and `legal-audit`; a stale reference in a rule about
   accessibility belongs to `claude-file-audit`. One finding, one entry, attributed
   to the domain that owns the remedy.
2. **Rank across domains, not within them.** A legal blocker outranks an
   accessibility polish item. Severity is the sort key; domain is a column.
3. **Group by remedy**, because that is how the work actually gets done: the
   tidy-up PR, the new assertions, the issues. Several small `claude-file-audit`
   findings usually collapse into one PR.
4. **Keep the legal reading list separate.** It is for the user's judgement, never
   mixed into the findings and never turned into an issue on your initiative.

## Approval and follow-through

One pass, at the end:

- Present the merged report and recommend which findings should become issues.
  Dedupe against open **and** closed issues first (`audit-loop.md` §G) — the
  backlog is small and deliberately curated.
- File only what the user picks, through `create-issue`, labelled `audit`.
- Criteria changes from any research pass ship as **separate** PRs, one per domain,
  through `implement` — never folded together and never mixed with a findings fix.
- Tidy-up fixes ship as their own PR, also through `implement`.

## Reporting back

One summary: which domains ran, which did a research pass and which skipped on
cadence, the finding count by severity and domain, what became issues (with
numbers), what became PRs, what was dropped and why, and — separately — the legal
reading list. Confirm the accessibility scaffolding is cleaned up (`launch.json`
reverted, preview stopped, temp `DATA_DIR` deleted).
