---
name: dependabot
description: >-
  Check for, review, and merge open Dependabot dependency-update PRs. Use when
  asked to handle/triage/merge Dependabot PRs, clear the dependency-update
  backlog, or "merge what's safe". Merges every PR that passes review and, for
  each intentionally held one, leaves a PR comment explaining why and labels it
  `blocked` so `pick-issue` skips it until re-checked here.
---

# Handle open Dependabot PRs

Dependabot opens weekly PRs for npm deps and GitHub Actions (see
`.github/dependabot.yml`, limit 5 npm at a time). Each already runs the CI + Lint
workflows. Your job: get every safe one merged, and for the rest, leave a
paper trail so a human knows exactly what's blocking it.

**Merging is outward-facing and hard to reverse.** Only merge PRs that pass
review. Report every action taken (merged / commented / skipped) at the end.

**This skill owns the `blocked` label.** A PR held open *on purpose* (a major
bump with breaking changes we use, one that would violate a settled
architecture call in `CLAUDE.md` — a frontend framework, a third persistence
backend, weakened tenant isolation, etc.) gets the `blocked` label plus an explanatory
comment. That label is how `pick-issue` knows to leave the PR out of its
candidate pool — so a held PR stays open and visible without being repeatedly
re-triaged as "pickable work". **This sweep is the only place a `blocked` PR is
re-evaluated**, so it must look at already-`blocked` PRs too, not just fresh
ones: re-check each, and clear the label + merge once its blocker is gone.

## 1. Find the open Dependabot PRs

```bash
gh pr list --author "app/dependabot" --state open \
  --json number,title,labels,mergeable,mergeStateStatus,url
```

If none, say so and stop. Otherwise process each PR independently, oldest first
(older PRs may be superseded by newer ones for the same package — note that).

## 2. Review each PR

Run the **`review-pr`** skill on each PR number — that covers mergeable state, CI
status, diff reading, and this repo's constraints. Do that first.

Then apply the **Dependabot-specific** checks on top:

- **Bump type (semver).** Read the title (`Bump X from 1.2.3 to …`).
  - *patch* / *minor*: low risk for a well-behaved package. Still confirm CI is
    green and the diff is only a lockfile + `package.json` version change.
  - *major*: potentially breaking. Read the release notes / changelog in the PR
    body (Dependabot includes them) and the package's CHANGELOG for the version
    range. Check whether our code actually uses the changed/removed APIs. A major
    bump is `NOT SAFE` unless you can point to why the breaking changes don't
    affect us. Express, multer, and eslint are the ones most likely to bite.
- **Security update?** A `security`/`Dependabot security` label or a linked
  advisory raises priority — but does *not* lower the safety bar. Still review;
  a fix can itself be a major bump.
- **Grouped PRs.** If a PR bumps several packages at once, review each package in
  it; the whole PR is only as safe as its riskiest member.
- **What changed beyond the manifest.** For a pure version bump the diff should be
  just `package.json` + `package-lock.json` (or the workflow YAML for an Actions
  bump). Any source change in the diff is unexpected → scrutinize.
- **Compatibility signal.** Dependabot's compatibility-score badge is a weak
  hint, not proof; CI + the checks above are what decide it.

## 3. Merge the ones that pass

For each PR whose verdict is SAFE TO MERGE:

```bash
gh pr merge <PR> --squash --delete-branch
```

- Squash keeps history clean (one commit per update). Don't merge a PR whose
  required checks aren't green — if a check is still pending, wait and re-check
  rather than forcing it.
- **If the PR was previously `blocked` and its blocker has now cleared** (CI now
  green, a major's breaking change no longer affects our code, a peer-range
  conflict lifted, …), remove the label as you merge so the paper trail stays
  honest — the merge deletes the branch, but drop the label first if you're not
  merging in the same step: `gh pr edit <PR> --remove-label blocked`.
- After a merge, later PRs may now be `BEHIND`/conflicting. Dependabot usually
  rebases them automatically within a minute or two; if one is stuck, comment
  `@dependabot rebase` on it rather than resolving conflicts by hand.

## 4. For each PR that did NOT pass — leave a trail *and* label it `blocked`

Do **not** silently skip it. Two steps, so both a human and `pick-issue` know
where it stands:

**a. Comment** the blocker and the exact next step, so a human can act without
re-deriving your analysis:

```bash
gh pr comment <PR> --body "Not merged: <reason>. To unblock: <concrete step>."
```

**b. Label it `blocked`** so `pick-issue` drops it from the candidate pool (it
reads labels, not comments — see that skill's phase 1). Create the label once if
the repo doesn't have it yet, then apply it:

```bash
gh label create blocked --color B60205 \
  --description "Held open on purpose; excluded from pick-issue" 2>/dev/null || true
gh pr edit <PR> --add-label blocked
```

Leave the PR **open** — the label + comment are the whole point; don't close it.
(If a bump should be stopped for good rather than merely held, a human can still
choose `@dependabot ignore this major version`; labeling doesn't preclude that.)

Examples of reason → next step:

- *Major bump with breaking changes we use* → "review `<API>` usage in
  `<file>`, adapt call sites, then re-run CI." (Express, multer, and eslint are
  the majors most likely to bite here.)
- *Violates a settled architecture call* (a frontend framework/bundler, a third
  persistence backend, a dependency `CLAUDE.md` explicitly forbids) → cite the
  `CLAUDE.md` rule it violates; "held until we deliberately decide to change that
  policy."
- *CI failing* → name the failing check and the error; "fix X, push, re-review."
- *Merge conflict / behind base* → "comment `@dependabot rebase`, then re-review."

Default to **holding open with the `blocked` label** (step b above), not closing —
an open, labeled PR stays a visible, re-checkable reminder while staying out of
`pick-issue`'s pool. Use a Dependabot control command only when it genuinely fits:
`@dependabot rebase` / `@dependabot recreate` for a stuck or stale PR, and
`@dependabot close` / `@dependabot ignore this major version` only to stop a bump
*for good* (add the reason in a preceding human comment first) — not as the
routine way to park a hold.

## 5. Report

Summarize as a short list: each PR → action (merged / held-`blocked`-and-commented /
label-cleared-and-merged / skipped) → one-line reason. Make clear how many merged
and how many are now held `blocked` (open, out of `pick-issue`'s pool) and what a
human would need to do to unblock each.
