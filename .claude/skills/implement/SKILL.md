---
name: implement
description: >-
  End-to-end workflow for implementing a change: branch from up-to-date main,
  write the prod code + tests, review locally, commit/push, open a PR, review it,
  merge if safe, watch main's CI, and clean up the branch. Use whenever you're
  told to implement, build, add, fix, or otherwise ship something — a GitHub
  issue on this repo, a directly requested change, or similar. Not for reviewing
  someone else's PR (use `review-pr`) or triaging Dependabot (use `dependabot`).
---

# Implement a change end-to-end

Goal: take an implementation request (a GitHub issue, a described change, a bug
fix, …) all the way from a fresh branch to a merged PR with green CI on `main`,
without leaving stale local state behind. Work the phases in order; each one
gates the next.

**This ships code and touches the remote.** Pushing, opening a PR, and merging
are outward-facing and hard to reverse — do them deliberately, and never merge a
PR your own review says isn't safe. If a phase's exit condition isn't met, stop
and report rather than pushing ahead.

First, be sure you understand the task. If it's a GitHub issue, read it:
`gh issue view <N>`. If the request is ambiguous in a way that changes what you'd
build, ask before writing code — not after.

## 1. Branch from up-to-date main

Never commit on `main`. Start from a current base:

```bash
git switch main
git pull --ff-only
git switch -c <type>/<short-slug>    # e.g. feat/session-export, fix/vote-tie
```

- Ensure the working tree is clean first (`git status`); stash or resolve
  anything unexpected before branching.
- Pick a descriptive branch name. If implementing an issue, include its number
  (`feat/42-session-export`) so the PR links back.

## 2. Implement — prod code plus tests

Build the actual feature/fix in the production code, following this repo's
architecture and `CLAUDE.md` (no build step, no framework, no DB, no auth; store
mutated in place; routers in `routes/*.js`; frontend shared-global-scope scripts
in load order). Re-read the relevant `.claude/rules/` before touching an area
they cover.

Add automated tests wherever applicable — this is not optional when the change is
testable:

- New/changed backend behavior → add or extend a `test/*.test.js` spec. Use
  `test/helpers.js` so the store gets an isolated temp `DATA_DIR` (see the
  `automated-tests` rule and the `test-data` skill). Never touch the real
  `data/`.
- User-facing text → add the key to **both** `public/js/lang/en.js` and
  `de.js` (i18n parity is tested).
- New top-level name in `public/js/**` → update the `globals` list in
  `eslint.config.js`, and watch the load-order trap.

Keep the change focused on the request; don't fold in unrelated edits.

## 3. Review the local changes thoroughly

Convince yourself it actually works before anything leaves the machine. Read your
own diff end to end:

```bash
git diff
npm test
npm run lint
npm run check:syntax
```

- All three must pass. Read the diff critically for correctness, edge cases, and
  the repo constraints above — not just "tests are green."
- For UI-affecting changes, verify in a real browser via the preview workflow
  (the `verify` skill / preview tools), not tests alone.
- Consider running `/code-review` on the working diff for a second pass.
- Only proceed once you genuinely expect it to behave as intended. If review
  turns up problems, fix them and re-run this phase.

## 4. Commit, push, open the PR

```bash
git add -A
git commit    # clear message: what changed and why
git push -u origin HEAD
gh pr create --fill   # or --title/--body; reference the issue ("Closes #42")
```

- Write a real commit message (subject + body if the change warrants it), and end
  it with the required trailer:

  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

- The PR body should explain what and why, note that tests were added/updated,
  and link the issue. End the body with:

  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```

## 5. Review the PR

Run the **`review-pr`** skill on the PR you just opened. It checks mergeable
state, CI status, reads the diff, and enforces this repo's constraints, then
returns a verdict: `SAFE TO MERGE` or `NOT SAFE` with concrete blockers.

Review your own PR honestly — the fact that you wrote it is not evidence it's
correct. Wait for CI (`gh pr checks <PR> --watch`) so the verdict reflects real
check results, not pending ones.

## 6. Merge — only if the review allows it

- If the verdict is **NOT SAFE**: do **not** merge. Address each blocker (go back
  to phase 2/3, push fixes, re-review) or, if it's out of your hands, report what
  needs to happen and stop.
- If **SAFE TO MERGE** and required checks are green:

  ```bash
  gh pr merge <PR> --squash --delete-branch
  ```

  `--delete-branch` removes the remote branch. Squash keeps `main` history to one
  commit per change.

## 7. Monitor main's CI

The merge triggers the **CI** and **Lint** workflows on `main`. Confirm they go
green — a merge that red-lights `main` is not "done":

```bash
gh run list --branch main --limit 3
gh run watch <run-id>          # or: gh run view <run-id> --log-failed
```

If a workflow fails on `main`, treat it as urgent: investigate the failure and
open a follow-up fix (a new branch through this same workflow). Report it either
way.

## 8. Clean up local state

Back on your machine, return to an up-to-date `main` and drop the merged branch:

```bash
git switch main
git pull --ff-only               # brings in the squash-merge commit
git branch -d <type>/<short-slug>  # delete the now-merged local branch
git remote prune origin          # optional: clear the deleted remote ref
```

Use `git branch -d` (safe: refuses if not merged) rather than `-D`. If `-d`
complains the branch isn't merged, that's a signal something didn't land — stop
and check, don't force-delete.

## Report

Summarize what shipped: the branch, the PR (link + merge state), test coverage
added, the review verdict, main's CI status, and confirmation the local branch is
cleaned up. If you stopped early at any gate, say exactly where and why.
