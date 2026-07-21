# A11y (#145): measure contrast against the PAGE, and every sheet needs a focus trap

The accessibility/mobile audit (#145) found the mobile layout already solid — no
horizontal overflow at 375px anywhere — and `prefers-reduced-motion` correctly
gating all four animations. What it did find clusters into two traps that are
easy to reintroduce, because neither produces an error, a failing test, or a
visibly broken screen.

## 1. A colour is not "accessible on white" — check the darkest THEME page

The single most expensive mistake in this audit was measuring text colours
against `#fff`. That is the wrong background for a large part of the UI: cards
are white `--surface`, but a bare `.link-btn` ("Session löschen", the
breadcrumbs) paints straight onto `--page-bg`, which is a **round-chosen theme**
— the darkest being Schiefer `#e9eef3`.

Checking white alone passed three colours that were actually below AA:

| | on white | on Schiefer |
|---|---|---|
| `--good` (old `#16a34a`) | 3.30 ✗ | 3.03 ✗ |
| `--warn` (old `#b45309`) | 5.02 ✓ | **4.30 ✗** |
| `--danger` (old `#dc2626`) | 4.83 ✓ | **4.14 ✗** |

**Rule:** any colour used as text gets measured against **both** `--surface` and
the darkest `THEMES` page. `test/a11y-contrast.test.js` does exactly this, and it
reads `THEMES` out of `views-round-detail.js` so a **newly added theme is checked
automatically** rather than quietly escaping the suite.

### The accent is text, not just a fill

`THEMES[].accent` becomes `--brand`, and `--brand` is what `.link-btn` paints
breadcrumbs and inline actions with. So an accent has to clear 4.5:1 **on its own
page** too. Sand and Pfirsich sat at 3.8:1, which meant picking either theme put
*every link in the app* below AA — invisible unless you happen to test on those
two themes. Both were darkened; the other six already passed.

### Correcting a theme needs no migration — resolve at RENDER time

A round stores a **snapshot** of the palette (`{type:'theme', page, accent}`), so
fixing a theme's accent in `THEMES` would leave every round that already picked
it on the old, failing value forever. `resolveAccent(bg)` in `core.js` looks the
accent up by `page` on every render instead, so existing rounds are corrected the
next time they draw. Same render-time-not-capture-time reasoning as
`.claude/rules/provider-cover-sizing.md`, and it keeps the repo free of one-time
migration code (CLAUDE.md). Both `applyBackground` and `themeAccent` go through
it, so a home-screen emblem can't show a different accent than the round screen.

### `avgColor()` is used in BOTH directions — that is what pinned its lightness

The rating scale is a fill under white text (`.score-pill`) *and* text/stroke on
the page (`.gd-ring__num`, the ring). At `hsl(h, 60%, 42%)` the yellow-green
middle was 2.4:1 under white — every rating badge in the app failed. It is now
**30%**, the lightest value clearing 4.5:1 under white across the whole hue range
while the ring still clears the 3:1 large-text bar on every theme page. Don't
lighten it without re-checking both uses.

**Also: hex rounding eats the last hundredth.** Deriving a palette by scaling RGB
toward black and rounding to 8-bit hex landed three member colours at
4.48–4.49:1 — *just* under. Aim at ~4.52 and assert on the rounded hex, which is
what the test does (it caught this, not review).

## 2. `aria-modal` constrains screen readers, NOT the keyboard

All five sheets were `role="dialog" aria-modal="true"` and still let Tab walk
straight out into the page behind the backdrop — measured: **20 of 35 tabbable
elements were outside the open sheet** — and closing one dropped focus to
`<body>`, so a keyboard user restarted from the top of the document every time.

`public/js/focus-trap.js` fixes both, and **every sheet must go through
`openSheet(backdrop, onKey)`** (`views-round-detail.js`) rather than assigning
`activeSheet` directly — that is what makes it impossible to add a sixth sheet
that silently misses the trap. Two ordering details are load-bearing:

- **Install the trap before moving focus into the sheet.** `trapFocus` captures
  `document.activeElement` as the restore target, so a sheet that focuses its
  first field before calling `openSheet` would "restore" focus to its own input.
- **Release AFTER removing the sheet** — restoring focus to the opener while the
  dialog is still attached gets undone a moment later.

## 3. State conveyed by colour alone (the recurring shape)

The seat picker, the 1–5 rating buttons and the hub tabs all signalled their
state with a class and a colour only. Note `paintTagChip` had already solved this
properly — the pattern existed, it just wasn't applied to the newer controls.
Toggles get `aria-pressed`, the current tab gets `aria-current="page"`.

## 4. A live region must already be in the tree

`toast()` is the app's only channel for confirmations *and* errors, and it
announced nothing. Adding `role="status"` is **not** enough on its own: a live
region that is inserted — or un-`hidden` — **with its text already in place is
never announced**. The element therefore stays permanently in the accessibility
tree and visibility is a **class** (`.toast.is-on`), never the `hidden`
attribute. `toast()` also clears the text on hide, so re-showing the *same*
message is still a mutation the region reports.

## Things that are fine — don't "fix" them

- **Focus rings.** Nothing removes them globally; the browser default
  `outline: auto` shows on `:focus-visible`. The two `outline: none` rules
  (`.search-pill input`, `.paste-zone`) both provide a replacement indicator.
  Note `el.focus()` from a script does **not** set `:focus-visible` in Chrome, so
  probe this with a real Tab keypress or you will "find" a bug that isn't there.
- **The remaining small targets** (`.round-footer .link-btn` at 21.5px,
  `.tl-act__del` at 23.8px) pass **WCAG 2.2 SC 2.5.8 via the spacing exception**
  — measured 33.5px between centres, above the 24px the exception requires. They
  were left alone deliberately.
- **`<html lang>`** is set dynamically by `i18n.js`; the static `lang="en"` in
  `index.html` is only the pre-boot value.

## Auditing this app again

Drive it against a **generated dataset in a temp `DATA_DIR`**, never the real
`data/` (`.claude/rules/no-reading-production-data.md`) — the committed
`.claude/launch.json` config uses the production folder, so add a throwaway
config with `DATA_DIR` overridden and revert it before committing.

The Browser pane will happily report **`innerWidth === 0` / `innerHeight === 0`**
after some navigations, which makes every element measure `width: 0` and any
"is it visible" probe return nothing — it reads exactly like the change under
test having blanked the page. It is the pane artifact family in
`.claude/rules/preview-pane-paint-artifacts.md`; `resize_window` to a real size
and re-probe **before** believing a regression. And clear the service worker
(`getRegistrations().unregister()` + `caches.delete`) after every CSS edit, or
the cache-first shell keeps serving the old `styles.css` and your fix looks
inert.
