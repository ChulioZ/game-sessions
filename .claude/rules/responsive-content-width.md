# The content column has ONE width, because navigation lives inside it

`.app` is capped at `--w-content` (1000px) on every screen, and
`test/content-width.test.js` fails if anything gives it or the `.site-footer`
that mirrors it a second width — by `:has()`, by media query, or by a modifier
class.

That is not conservatism. #332 shipped a second, wider width for grid screens
and it had to be reverted within hours. The reasoning is worth keeping, because
the mechanism looked (and was) correct, and the defect it caused is invisible
from any single screenshot.

## What went wrong

The rule was `.app:has(.cards, .pokale-cards, .lobby-list) { max-width: 1440px }`
— content-conditioned, so no view could forget it, failing to the narrow width.
All true, and all irrelevant, because of one thing it didn't account for:

**`.app` is centred (`margin: 0 auto`), so changing its width moves BOTH edges
— and the hub tab strip lives inside `.app`.** Measured at 1920:

| Tab | `.app` | strip left edge |
|---|---|---|
| Start | 1000 | 480 |
| Regal | 1440 | **260** |
| Chronik | 1000 | 480 |
| Pokale | 1440 | **260** |

The widths alternate along the tab row, so the navigation control slid 220px
back and forth as the user moved across it — it shifted out from under the
cursor that was clicking it. And it was not confined to tabs: 8 of the 12 SPA
screens changed width relative to their neighbours.

## The constraint (this is the part to remember)

Two requirements, each individually obvious:

1. **Within** a screen, the tab strip and the content need a shared edge — a
   strip floating 220px away from the heading it labels reads as unattached.
2. **Across** screens, the strip must not move.

Together they force **every screen that shares the strip to share one column
width**. So "wider grids" and "stable navigation" are mutually exclusive for as
long as navigation sits inside the content column. No `:has()` list reconciles
them, and neither does any of the alternatives that look promising:

- **A per-view width flag** — worse, not better. There is no "begin view" hook
  in this frontend (every `show*` clears `#app` itself), so a flag has to be set
  in ~20 places and cleared in the rest, and the first view that forgets it
  renders at the *previous* screen's width.
- **Stable container, content capped and left-aligned inside it** — removes the
  jump (measured 0px), but text screens then hug the left of a centred column
  with ~660px dead to the right, and the footer, which centres itself, no longer
  lines up with the content it follows.
- **Stable container, content capped and centred inside it** — text screens keep
  today's look, but on grid screens the strip floats mid-page while the heading
  and grid start at the left. Prototyped both; neither is shippable as-is.

## When this rule can be lifted

When navigation moves **out** of the content column — the desktop rail
(≥1280px; below that the strip and dock are unchanged). Once the rail owns
navigation, the content pane's width depends on the **viewport only**, never on
which screen is showing, so nothing that stays on screen can move and the pane
is free to be as wide as the shell allows.

The rail is why the one-width test says to *replace* its assertion with the
rail's own left-edge-stability probe rather than delete it. The invariant that
matters is "persistent chrome does not move", and the width cap is only today's
way of guaranteeing it.

A rail is not free horizontally: 260px + a 32px gap costs 292px, so **below
1280px a rail yields fewer Regal columns than today** — which is where that
breakpoint comes from, rather than from taste.

## What survived from #332, and why

- **The phone Regal is two columns.** A 220px floor needs 456px for two, so
  every phone got one, and a 22-game shelf measured ~6300px of scroll. The floor
  drops to 150px below 520px; at 390px that is two 175px columns and the scroll
  roughly halves (6235 → 3463 measured on one dataset). Unrelated to the width
  question and uncontroversial.
- **The home lobby is a grid** from 860px up. Still tiles 2-up inside a 1000px
  column, so it kept its value after the revert.

Both are pinned as **arithmetic over the declared numbers** — how many columns
the grid actually gets at a given viewport — not as "a rule mentioning grid
exists". A floor nudged 150px → 180px passes every naive assertion while
silently restoring one column; only the column count notices.

## Verifying layout work here

- **An empty screen tells you nothing.** The Pokale tab measured 1000px and
  looked like the rule was broken; the round simply had no finished sessions, so
  it rendered its empty state and contained no grid at all. Seed content for
  every screen you intend to measure.
- **Measure the transition, not the screen.** Every individual screen in #332
  measured correctly. The defect only exists *between* screens — so walk the
  whole set at a fixed viewport and diff the position of anything persistent:
  ```js
  Math.max(...lefts) - Math.min(...lefts)   // must be 0 across all 12 screens
  ```
  That one probe would have caught this before it shipped, and it is the
  standing check for any future shell change.
- Probe with `getComputedStyle(el).gridTemplateColumns`, element rects and
  `document.scrollHeight` rather than pixels
  (`.claude/rules/preview-pane-paint-artifacts.md`); screenshot only right after
  a fresh `navigate`; clear the service worker before believing any
  `styles.css` edit (`.claude/rules/pwa-service-worker.md`); and drive it
  against a generated dataset in a temp `DATA_DIR` — the committed
  `.claude/launch.json` points at the production folder
  (`.claude/rules/no-reading-production-data.md`).

## The cover budget, for when width does change

More columns mean more covers decoded at once, so `COVER_CARD` (330px) looks due
for a re-check (`.claude/rules/provider-cover-sizing.md`). It holds: `.cards`
uses **`auto-fill` with a `1fr` max**, so extra room becomes extra *columns*,
not wider cards — measured 220px per card at 1920 and 235px at 1280, i.e. still
at the floor. On a phone the card is 175px while we still request 330px, which
is 1.9×, inside the DPR headroom the constant is built from.

That reasoning depends on `auto-fill`; switching to `auto-fit` would collapse
empty tracks and let cards balloon on a sparse shelf, which *would* put the
budget back in play.

**Related:** `.claude/rules/responsive-hub-tabs.md` (the strip/dock breakpoints
this sits on top of), `.claude/rules/css-text-assertions-strip-comments.md`
(how `test/support/css.js` parses the sheet).
