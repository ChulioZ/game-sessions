# The hub tabs branch on WIDTH alone (#331) — and the clearance follows the dock

The four hub tabs (Start / Regal / Chronik / Pokale) are one element with two
presentations: the floating bottom dock below 860px, an in-flow strip at the top
of the content column from 860px up. The information architecture is untouched —
only the placement was ever a phone convention.

## 1. Width, deliberately — not `pointer` and not `display-mode`

Three signals were on the table and the other two are traps:

- **`pointer: coarse` / `hover: none`** is the *ergonomic* reason bottom bars
  exist, so it looks like the principled choice. But it keys on the input
  device, not the room available: a touchscreen laptop or a Surface at 1920
  would keep the floating dock — which is the exact defect this issue fixed
  (the dock overlaying the third row of the Regal grid for the whole scroll).
- **`display-mode: standalone`** ("installed, so make it feel like an app")
  breaks the same way in the other direction: an installed desktop PWA gets a
  bottom dock on a 27" monitor, and the same screen then looks different in the
  browser and in the installed app for no reason the user can see.
- **Combining them** produces a four-cell matrix nobody can hold in their head,
  and a narrow desktop *window* would still disagree with a phone at the same
  width.

Width also keeps this axis consistent with the rest of the stylesheet: every
other breakpoint here (520 / 640 / 860) is a width, and the wide-screen layout
work sequenced after this one is width-based too. **If you add a device-class
branch later, add it to this file's reasoning rather than beside it** — two
independent switching signals in one stylesheet is the thing this avoided.

## 2. 860/859 must stay ADJACENT, or #324 comes back

`@media (max-width: 859px)` reserves the dock clearance; `@media (min-width:
860px)` makes the dock an in-flow strip. Those two numbers tile the axis with no
gap **on purpose**. Widen the gap — say the strip starts at 900 — and in the
860–899 band the dock is still `position: fixed` (the base rule) while nothing
reserves room for it, so it paints straight over the Impressum links and the
"Powered by BGG" logo. That is precisely the #324 regression, reintroduced by
editing one number in a block that looks unrelated.

`test/dock-footer-clearance.test.js` pins the adjacency (`min === max + 1`) by
brace-matching the two media blocks out of the stylesheet. 860 was reused rather
than invented: `.vote--split` already keys its wide layout off it.

## 3. The clearance is conditioned on a dock that ACTUALLY floats

`--dock-clearance` (120px) is applied to `.app` **and** to the `.site-footer`
that follows it, from one variable so they can't drift (#324). Since #331 both
reserves hang off `.app:has(.dock:not(.dock--sub))` inside the phone-width
block. Three things about that selector are load-bearing:

- **`.app` used to carry the reserve unconditionally**, so the eight round
  sub-screens that render no dock at all each paid 120px of dead space. That is
  what the `:has()` condition removes.
- **`:not(.dock--sub)` is not decoration.** The sub-screen strip is
  `display: none` below the breakpoint — and a `display: none` element still
  matches `:has()`, so a plain `:has(.dock)` would quietly put the 120px back
  onto exactly the screens this freed.
- **Specificity, not source order, is what makes it work.** `.app:has(.dock…)`
  is (0,2,0) and beats the `.app { padding: … }` shorthand (0,1,0) even though
  the ≤520px override is declared ~1600 lines later. Don't "fix" that by
  restating the clearance in the narrow block — that reintroduces the hardcoded
  duplicate the shared variable exists to prevent.

## 4. The nav is PREPENDED, and `aria-current` differs by screen kind

`renderHubTabs` prepends into `.app`. On a phone the element is `position:
fixed`, so its DOM position is inert there and the dock looks exactly as before;
on desktop it has to precede the content, and navigation-before-content is the
better tab order anyway.

Two states that read the same visually and must not be collapsed:

| Screen | `aria-current` | Owning tab on plain left-click |
|---|---|---|
| a hub tab (Regal, on `/round/:rid/regal`) | `"page"` | **inert** — `navLink(el, path, null)`; it points at the screen you are on |
| a sub-screen (game detail, tags, …) | `"true"` | **live** — clicking it is how you go up to that section |

`"page"` on a sub-screen would announce the game-detail screen as if it *were*
the Regal. `"true"` says "current item in this set" — the section you are
inside — which is what is actually true.

`HUB_TAB_OF` (views-round.js) maps each sub-screen's router segment to its
owning tab, keyed the way `resolveRoute` names them. A new sub-screen that
forgets its entry falls back to `start` rather than rendering a wrong owner —
check it when you add one.

## Verifying a change here

`styles.css` is a cache-first shell asset: unregister the service worker and
clear its caches first, or you are looking at the old bytes
(`.claude/rules/pwa-service-worker.md`). Drive the checks with JS probes rather
than pixels — `getComputedStyle(dock).position`, the element's rect, `.app` and
`.site-footer` `paddingBottom` at 390 and 1280 — because the Browser pane
produces blank captures after synthetic scrolls and can report
`innerWidth === 0` after a navigation
(`.claude/rules/preview-pane-paint-artifacts.md`); `resize_window` then a fresh
`navigate` is what gives a trustworthy screenshot. For the inert-vs-live tab
distinction, count `history.pushState` rather than wrapping the view functions —
they are lexically scoped consts, not `window` properties
(`.claude/rules/in-app-nav-links.md`).

And break the CSS on purpose once to watch the clearance assertions go red — a
CSS-text test gives no other signal that it is wired to anything real
(`.claude/rules/css-text-assertions-strip-comments.md`).

**Related:** `.claude/rules/in-app-nav-links.md` (the `navLink` contract these
tabs are built on), `.claude/rules/css-text-assertions-strip-comments.md` (how
the guarding test parses the stylesheet).
