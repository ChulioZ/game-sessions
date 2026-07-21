# A11y (#145): measure contrast against the PAGE, and every sheet needs a focus trap

The #145 audit's findings cluster into traps that produce no error, no failing
test, and no visibly broken screen — easy to reintroduce.

## 1. A colour is not "accessible on white" — check the darkest THEME page

Cards are white `--surface`, but bare `.link-btn`s (breadcrumbs, "Session
löschen") paint straight onto `--page-bg`, a **round-chosen theme** — darkest
is Schiefer `#e9eef3`. Measuring against `#fff` alone passed three colours
(`--good`, `--warn`, `--danger`) that were below AA on Schiefer.

**Rule:** any colour used as text gets measured against **both** `--surface`
and the darkest `THEMES` page. `test/a11y-contrast.test.js` does exactly this
and reads `THEMES` out of `views-round-detail.js`, so a newly added theme is
checked automatically.

- **The accent is text, not just a fill.** `THEMES[].accent` becomes
  `--brand`, which paints every `.link-btn` — so an accent must clear 4.5:1
  **on its own page** (Sand and Pfirsich sat at 3.8:1 and put every link in
  the app below AA; both were darkened).
- **Correcting a theme needs no migration — resolve at RENDER time.** A round
  stores a palette *snapshot*, so `resolveAccent(bg)` in `core.js` looks the
  accent up by `page` on every render; existing rounds self-correct on next
  draw. Both `applyBackground` and `themeAccent` go through it. (Same
  render-time reasoning as `provider-cover-sizing.md`; keeps the repo free of
  migration code.)
- **`avgColor()` is used in BOTH directions** — fill under white text
  (`.score-pill`) *and* text/stroke on the page (`.gd-ring__num`). Its
  lightness is **30%**: the lightest value clearing 4.5:1 under white across
  the whole hue range while the ring still clears 3:1 (large text) on every
  theme. Don't lighten it without re-checking both uses.
- **Hex rounding eats the last hundredth.** Scaling RGB toward black and
  rounding to 8-bit hex landed colours at 4.48–4.49:1 — just under. Aim at
  ~4.52 and assert on the rounded hex (the test does; it caught this).

## 2. `aria-modal` constrains screen readers, NOT the keyboard

All five sheets were `role="dialog" aria-modal="true"` and still let Tab walk
out into the page behind the backdrop, and closing one dropped focus to
`<body>`. `public/js/focus-trap.js` fixes both, and **every sheet must go
through `openSheet(backdrop, onKey)`** (`views-round-detail.js`) rather than
assigning `activeSheet` directly — that makes it impossible to add a sheet
that silently misses the trap. Two orderings are load-bearing:

- **Install the trap before moving focus into the sheet** — `trapFocus`
  captures `document.activeElement` as the restore target, so focusing first
  would "restore" focus to the sheet's own input.
- **Release AFTER removing the sheet** — restoring focus to the opener while
  the dialog is still attached gets undone a moment later.

## 3. State conveyed by colour alone

The seat picker, rating buttons and hub tabs signalled state with a class +
colour only (`paintTagChip` had already solved this — the pattern just wasn't
applied to newer controls). Toggles get `aria-pressed`, the current tab
`aria-current="page"`.

## 4. A live region must already be in the tree

`toast()` is the only channel for confirmations *and* errors. `role="status"`
alone is not enough: a live region inserted — or un-`hidden` — **with its text
already in place is never announced**. The toast element stays permanently in
the tree; visibility is a **class** (`.toast.is-on`), never the `hidden`
attribute, and `toast()` clears the text on hide so re-showing the same
message is still a reported mutation.

## Things that are fine — don't "fix" them

- **Focus rings.** Nothing removes them globally; the two `outline: none`
  rules (`.search-pill input`, `.paste-zone`) both provide a replacement.
  Note `el.focus()` from a script does **not** set `:focus-visible` in Chrome
  — probe with a real Tab keypress or you'll "find" a bug that isn't there.
- **The remaining small targets** (`.round-footer .link-btn`, `.tl-act__del`)
  pass WCAG 2.2 SC 2.5.8 via the spacing exception (33.5px between centres >
  the required 24px). Left alone deliberately.
- **`<html lang>`** is set dynamically by `i18n.js`; the static `lang="en"` is
  only the pre-boot value.

## Auditing this app again

Drive it against a generated dataset in a temp `DATA_DIR`, never the real
`data/` (`no-reading-production-data.md`) — the committed `.claude/launch.json`
uses the production folder, so add a throwaway config and revert it. The
Browser pane can report `innerWidth === 0`/`innerHeight === 0` after
navigations, making every element measure `width: 0` — that's the pane
artifact family in `preview-pane-paint-artifacts.md`; `resize_window` to a
real size and re-probe before believing a regression. And clear the service
worker after every CSS edit (snippet in `pwa-service-worker.md`, "Verifying a
shell-asset change") or the cache-first shell serves the old `styles.css` and
your fix looks inert.
