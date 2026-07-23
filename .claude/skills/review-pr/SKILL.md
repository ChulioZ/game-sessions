---
name: review-pr
description: >-
  Review a GitHub pull request end-to-end to decide whether it is safe to merge.
  Use when asked to review a PR, check if a PR is mergeable/safe, or vet changes
  before merging. Not tied to any PR author — works for human and bot PRs alike.
  For Dependabot-specific batch triage, use the `dependabot` skill (it calls this
  one per PR).
---

# Reviewing a PR for safe merge

Goal: produce a clear **verdict** for a single PR — `SAFE TO MERGE`, or
`NOT SAFE` with concrete reasons and what would have to change. Do not merge
here; the caller decides. Be honest: a PR that only *looks* fine (green CI, tiny
diff) can still be unsafe. Report what you actually verified.

Take the PR reference (number, URL, or branch) as input. All commands use `gh`.

## 1. Gather the facts

```bash
gh pr view <PR>                      # title, author, body, labels, state
gh pr view <PR> --json mergeable,mergeStateStatus,isDraft,reviewDecision
gh pr checks <PR>                    # CI / required-check status
gh pr diff <PR>                      # the actual change
```

- **Draft or already-closed?** Stop — not a merge candidate; say so.
- **Mergeable?** `mergeable: CONFLICTING` or `mergeStateStatus: DIRTY` means it
  has conflicts with the base branch → `NOT SAFE` (needs rebase). `BEHIND` means
  it needs updating from base before merge.

## 2. CI and required checks must be green

- Every check in `gh pr checks` must pass. Any `fail`/`pending` that is a
  *required* check → not mergeable yet.
- **Distinguish "failing" from "not yet run."** On a PR from a **fork** by an
  outside contributor, workflows may be *awaiting a maintainer's approval to run*
  rather than failing — checks show pending/expected because CI hasn't started.
  That is not a `NOT SAFE` blocker in itself; it means CI can't be judged yet.
  Note it, and (only after the diff looks safe — approving the run executes the
  contributor's code) let the run proceed so real results exist to review.
- **Green CI is necessary, not sufficient.** CI proves the suite passed; it does
  not prove the change is correct or complete. Still read the diff.
- If a check failed, open its log (`gh run view <run-id> --log-failed` or the
  check's details URL) and summarize *why* — that reason is the actionable part
  of a `NOT SAFE` verdict.

## 3. Read the diff — understand what and why

- Read the **whole** diff, not just the summary. Know what each hunk does.
- Match it against the PR's stated purpose. Does the change match the claim?
  Unrelated or unexplained changes are a red flag — call them out.
- Watch for: scope creep, secrets/credentials, changes to auth/security posture,
  data-format or schema changes, deletions of things you didn't expect, anything
  that contradicts how the PR describes itself.
- Weigh **blast radius**: a change to shared/core code, build, or CI config is
  higher-risk than a leaf change even if the diff is small.

## 4. Respect this repo's constraints

Cross-check the diff against `CLAUDE.md` and `.claude/rules/`. For this project
specifically, a PR is suspect if it:

- adds a **frontend framework/bundler** (beyond the sanctioned optional
  cache-busting build), a **third persistence backend** (beyond the
  JSON/Postgres pair), or weakens **tenant isolation / auth** — all settled
  architecture calls (`CLAUDE.md`) — **unless the PR is explicitly about
  that**. Also suspect: a *new* cloud/third-party service or dependency
  showing up unrequested as a side effect of unrelated work — see
  `CLAUDE.md`'s production-readiness mindset for when a mature dependency
  replacing hand-rolled code is legitimate versus gratuitous.
- adds a key to only one of `public/js/lang/en.js` / `de.js` (breaks i18n parity);
- adds a top-level name in `public/js/**` without updating the `globals` list in
  `eslint.config.js`, or introduces a load-order reference (see the rules);
- calls `app.listen()` in `lib/app.js`, or reassigns the `store` `data` object;
- commits anything under `data/`.

## 5. Contributor terms — commits must be DCO-signed off (CONTRIBUTING.md)

`CONTRIBUTING.md` requires every commit in a contribution to be **signed off**
under the Developer Certificate of Origin: a `Signed-off-by: Name <email>`
trailer (added with `git commit -s`) whose email is reachable and matches the
commit's author. A stable **GitHub username is fine** — the DCO certifies the
right to submit, not a legal name — so don't reject handles; anonymous /
throwaway identities are what fail. Opening the PR also licenses the change under
Apache-2.0, but that grant is automatic on submission; the **sign-off is the part
you can actually verify**, so verify it. The `DCO` CI check
(`.github/workflows/dco.yml`) is the authoritative gate — read its result in
`gh pr checks` — and this quick view lists any commit missing the trailer
locally:

```bash
gh pr view <PR> --json commits \
  --jq '.commits[] | select((.messageBody // "") | test("Signed-off-by:") | not)
        | "UNSIGNED " + (.oid[0:7]) + "  " + .messageHeadline'
```

- **Empty output = every commit is signed off.** Any `UNSIGNED …` line is a
  blocker: the PR is **NOT SAFE** until it's signed off. The fix is the
  **contributor's**, not yours (only the author can certify the DCO) —
  `git rebase --signoff main && git push --force-with-lease`, or for a single
  commit `git commit --amend --signoff --no-edit && git push --force-with-lease`.
  Report it; never add someone else's sign-off for them.
- The trailer's email should **match the commit's author/committer email** (the
  CI check enforces exactly this). A `Signed-off-by` with no email, or one that
  belongs to someone other than the author, doesn't count — flag it rather than
  passing it silently. A username in place of a real name is fine and not a
  reason to flag.
- **Exemption — the maintainer's own automation is not a third-party DCO
  contribution.** A **Dependabot** PR (author `app/dependabot`) is the
  maintainer's dependency automation, not a human contribution, so a missing
  `Signed-off-by` on its bot commits is **not** a blocker — don't fail a
  Dependabot PR on sign-off. (PRs opened by the `implement` skill already sign
  off their commits, so a self-authored PR passes this check normally.)
- The rest of `CONTRIBUTING.md`'s pre-PR checklist (branch off main, tests
  updated, i18n parity, README) overlaps phase 4's constraints and is covered
  there; sign-off is the one piece phase 4 doesn't check.

Note on squash-merge: this repo squash-merges, and GitHub may not carry a
`Signed-off-by` trailer from the PR's commits into the final squashed `main`
commit. The DCO is satisfied at the **PR-commit** level — which is exactly what
the check above inspects — so a missing trailer on the eventual squash commit is
a separate repo-config matter, not a review blocker.

## 6. Verify locally when the change warrants it

Green remote CI usually covers this, but verify locally when the diff touches
runtime behavior, or when you want proof beyond CI:

```bash
gh pr checkout <PR>
npm ci        # only if dependencies changed
npm test && npm run lint && npm run check:syntax
```

For UI-affecting changes, verify in a browser (see the preview workflow), not
just tests. Return to the base branch afterward (`git checkout main`).

## 7. Deliver the verdict

State one of:

- **SAFE TO MERGE** — with a one-line justification (what it does, checks green,
  diff reviewed, constraints respected).
- **NOT SAFE** — list each blocker and, for each, the concrete thing that would
  clear it (rebase, fix failing check X, split out unrelated change Y, add a
  missing lang key, etc.).

Keep it short and specific. The caller (or the user) acts on this.
