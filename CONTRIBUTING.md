# Contributing

Thanks for your interest in improving this project. Contributions are welcome —
please read this file first, especially the **[Contribution licensing](#contribution-licensing)**
section, because opening a pull request means agreeing to those terms.

## How to contribute

This repository is built and maintained with
[Claude Code](https://claude.com/claude-code), and it ships the workflow with it:
**skills** in `.claude/skills/` and **rules** in `.claude/rules/` that encode how
work gets done here. Whether you contribute by prompting Claude Code or by hand,
that is the intended path — start there rather than improvising. The README's
[Contributing](README.md#contributing) section walks through the skill workflow;
`CLAUDE.md` states the constraints you must work within.

In short, before opening a PR:

- Branch off an up-to-date `main` (never commit on `main`); use a descriptive
  name like `feat/session-export` or `fix/vote-tie`.
- Read `CLAUDE.md` and skim the relevant `.claude/rules/` for the area you touch.
- Add or update tests for testable changes, and add any new user-facing string to
  **both** `public/js/lang/en.js` and `de.js` (key parity is enforced by a test).
- Make `npm test`, `npm run lint`, and `npm run check:syntax` all pass.
- Update `README.md` in the same PR when the change adds or renames a user-facing
  feature, alters the file tree, or changes routes, scripts, or env vars.

## Contribution licensing

This is the important part. The project is **distributed** under the
[PolyForm Noncommercial License 1.0.0](LICENSE) (© 2026 Julian Zenker, the sole
rights holder and licensor). That outbound license is deliberately noncommercial.

To keep the project able to offer a commercial tier in the future without having
to track down past contributors, **inbound contributions are licensed under a
permissive license, not under PolyForm-NC**. Concretely:

> By submitting a contribution (a pull request, patch, or any change) to this
> repository, you license your contribution to the project maintainer under the
> **[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0)**.

You keep the copyright to your contribution — this is a license grant, not an
assignment. The permissive Apache-2.0 grant lets the maintainer distribute your
contribution as part of the project under PolyForm-NC today and under commercial
terms later, which a plain "inbound = same as outbound" arrangement would block
(it would leave the maintainer with only a noncommercial license to your work).

If you cannot agree to this — for example because your employer owns your work
and has not authorized the grant — please do not open a pull request; reach out
to the maintainer first instead.

## Developer Certificate of Origin (sign-off)

Every commit must be **signed off** to certify you have the right to submit it
under the terms above. Add the sign-off automatically with:

```bash
git commit -s        # appends a "Signed-off-by: Your Name <email>" trailer
```

The `Signed-off-by` line certifies your agreement with the **Developer
Certificate of Origin 1.1** (below, also at <https://developercertificate.org/>):

```
Developer Certificate of Origin
Version 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Use your real name and a reachable email in the sign-off (no anonymous or
pseudonymous contributions). That's it — thanks for contributing.
