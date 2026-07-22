---
name: accessibility-audit
description: >-
  Audit the app's UI/UX for accessibility against a maintained criteria list, and
  periodically refresh that list from current standards. Use when asked for an
  accessibility or a11y audit/review, to check WCAG conformance, or to find
  keyboard, screen-reader, contrast, focus or target-size problems in the UI.
  Drives the real app in a browser against generated data — never production
  data. Produces a ranked report; files issues only with your approval.
---

# Accessibility audit

Two jobs: keep `criteria.md` current with what accessibility actually requires of
*this* app, then audit the running UI against it.

**Read `.claude/skills/audit/audit-loop.md` first** — it owns the loop (research
gating, the critique test, how criteria change, the report format, and the rule
that findings only become issues with the user's approval). This file owns the
domain: where to look and how to probe it without being lied to.

Pass `--research` to force a research pass; otherwise the cadence in
`criteria.md` decides.

## Research sources (phase B)

Ask what changed **since `last-researched`**, not what accessibility is:

- **W3C** — WCAG (2.2 is the current Recommendation; treat 3.0 as a draft, i.e.
  not yet a criterion), WAI-ARIA, and the APG patterns for dialog, tabs, listbox
  and disclosure — the four patterns this UI actually uses.
- **EN 301 549** and the EAA/BFSG applicability question — but only far enough to
  hand the *legal* question to `legal-audit` (see A-R05). Do not decide a legal
  duty here.
- **Browser/platform changes** that invalidate a held technique: `:focus-visible`
  behaviour, `inert`, dialog element semantics, `prefers-reduced-motion`.

Then run the critique in `audit-loop.md` §C. Two conflicts are pre-recorded in
`criteria.md` (A-R02 target size, A-R03 `aria-modal`) — if research proposes
either again, that is the ledger working, not a new finding.

## Setting up a session you can trust (phase E)

Three things will each independently ruin an audit. Do all three before probing.

### 1. Never audit against production data

`.claude/launch.json` points `npm start` at the real `data/` folder — the group's
private rounds, members and ratings. A screenshot or `read_page` of that is the
same leak as reading the file (`.claude/rules/no-reading-production-data.md`).

Seed a throwaway dataset (`test-data` skill) and launch against it:

```bash
export AUDIT_DATA_DIR=$(mktemp -d)
```

Add a temporary `.claude/launch.json` entry pointing `DATA_DIR` at that folder,
or start the server yourself with `DATA_DIR` set and open the port with
`preview_start {url}`. **Revert `launch.json` before committing anything** — it is
tracked, and leaving an audit config in it changes how everyone else's preview
runs.

The dataset must cover every screen you intend to measure: an empty Pokale tab
renders an empty state and measures nothing, which reads exactly like a passing
check (`responsive-content-width.md`). Seed at least one round with ~12 games
across several tags, some archived and completed games, a finished session with
ratings, and one abandoned draw.

### 2. Clear the service worker after every CSS edit

The shell is served cache-first, so `styles.css` changes are invisible until you
unregister the SW and clear its caches — snippet in
`.claude/rules/pwa-service-worker.md` ("Verifying a shell-asset change"). An audit
that measures stale bytes reports fixed problems as live ones.

### 3. Assume the preview pane is lying, and probe with JS

The Browser pane misreports in ways that mimic real defects. All of these are
documented and none of them are app bugs:

- `window.innerWidth`/`innerHeight` can be `0` after a navigation, so every
  element measures `width: 0`. `resize_window` to a real size and re-probe.
- Screenshots go blank after any programmatic scroll; capture only right after a
  fresh `navigate`.
- `computer` scroll/input actions can time out for a whole session while the page
  stays fully responsive to `javascript_tool`.
- Lazy covers never load, because a zero-height viewport means the
  IntersectionObserver can never fire.

So: **measure with `javascript_tool` probes** (`getComputedStyle`, element rects,
`getAttribute`, `document.activeElement`), not pixels. See
`.claude/rules/preview-pane-paint-artifacts.md` and
`.claude/rules/provider-cover-sizing.md`.

Two probing traps specific to this domain:

- **`el.focus()` does not set `:focus-visible`** in Chrome. Checking focus
  indicators requires real Tab keypresses (`computer {action:"key", text:"Tab"}`),
  not scripted focus. Scripted focus produces phantom A-007 findings.
- **A synthetic click ignores modifier keys** for an anchor's default action, so
  it navigates instead of opening a tab and tears the page down. To check A-009,
  probe the *decision* (`e.defaultPrevented` on a document-level listener that
  blocks the browser), and probe every modified click **before** any plain one —
  the full recipe is in `.claude/rules/in-app-nav-links.md` §1.

## What to walk

Every screen, at **390px and 1280px** — the dock/strip switch is at 860px and the
rail takes over at 1280px, so the three presentations are genuinely different UIs
(`responsive-hub-tabs.md`, `responsive-content-width.md`).

- **Lobby & entry:** home, new round.
- **Round hub:** Start, Regal, Chronik, Pokale — plus the dock (<860), the strip
  (860–1279) and the rail (≥1280).
- **Round sub-screens:** game detail, member, tags, providers, design, move games,
  and both archives (retired, completed).
- **Session flow:** setup → vote steps → finale → results. Highest risk: it pushes
  history per step, traps nothing, and the rating faces are the main colour-state
  offenders. Exercise Back at a vote step, including the decline branch of the
  confirm (`session-flow-history.md`).
- **Sheets:** add game, link provider, feedback, support, provider image. Each one
  gets the A-004 Tab test.
- **Auth:** login, register, forgot, verify/reset landings — reachable only with
  `ACCOUNTS_ENABLED` + `SESSION_SECRET` set on your throwaway instance.
- **Standalone pages** (outside the SPA and outside i18n): `login.html`,
  `admin.html` (needs `ADMIN_PASSWORD`), and the legal pages, which 404 until
  `IMPRESSUM_ADDRESS` + `IMPRESSUM_EMAIL` are set.

## Prefer a test over a ticket

`test/a11y-contrast.test.js` already computes contrast ratios from the real
`THEMES` table, so a new theme is checked automatically. Any colour finding
belongs there as an assertion, not in an issue. Structural findings that read from
`styles.css` as text can follow `test/content-width.test.js` — parse via
`test/support/css.js` and strip comments first, or the selector regex silently
matches inside a comment (`css-text-assertions-strip-comments.md`).

Whatever you add, **break the production code once on purpose** and watch the
assertion go red. A CSS-text or DOM-shape test gives no other signal that it is
wired to anything real.

## Do not report these

They were each decided deliberately; re-reporting them wastes the user's review:

- The 24px-spacing-exception targets (A-R02).
- The scoped `outline: none` pairs that supply replacements (A-R01).
- `index.html`'s static `lang="en"` — `i18n.js` sets the real value at boot.
- Covers lacking `alt` — they are `background-image` decoration with adjacent
  titles (A-010).
- Anything already asserted in `test/a11y-contrast.test.js`; say it is covered and
  move on.

## Cleanup

Remove the throwaway `launch.json` entry, stop the preview server, and delete the
temp `DATA_DIR`. Confirm `git status` is clean of audit scaffolding before any
commit.
