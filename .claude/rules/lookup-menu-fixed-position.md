# The lookup dropdown is `position: fixed`, placed by JS — not `absolute`

The add-game / link-provider suggestion menu (`.lookup__menu`, built by
`attachLookup` in `public/js/views-round-lookup.js`) lives **inside a `.sheet`**, and a
`.sheet` sets `overflow-y: auto` so it can scroll its own content. That scroll
box is a **clipping context**: an `overflow` of `auto` forces the cross axis to
compute as non-`visible` too, so an `position: absolute` child menu opening
downward gets clipped at the sheet's edge (only the top row or two show, the rest
is unreachable — issue #96, worst in the short `.sheet--dialog`).

**Rule:** keep `.lookup__menu` as `position: fixed` and let `attachLookup`
position it against the **input's viewport rect** (`positionMenu()` sets
`left/width/top`-or-`bottom` and a viewport-capped `max-height`). A fixed element
is not clipped by an ancestor's `overflow`, so the menu floats free of the sheet
while the sheet still scrolls its content. Don't revert it to `absolute` +
`top: calc(100% + …)` — that reintroduces the clipping.

Gotchas baked into `positionMenu()` / `openMenu()`:

- **Reposition while open.** Because it's viewport-anchored, the menu must be
  re-placed when the sheet scrolls or the window resizes — `attachLookup` binds
  `scroll` (capture, to catch the sheet's own scroll) + `resize` listeners while
  the menu is visible and **removes them in `closeMenu()`** (bind only while open
  → no leak across sheet opens).
- **Cap to the viewport + flip up.** The menu is capped to the space available
  (never the full 340px if the viewport is short) and opens upward when there's
  more room above, so it never runs off-screen on short viewports.
- **Route every open through `openMenu()`** (not a bare `menu.hidden = false`) so
  positioning + listener binding always happen — both `showMenuMsg` and the
  results `render()` use it.

**Why the caveat matters:** a fixed element is positioned relative to the nearest
ancestor with a `transform`/`filter`/`will-change`, which would re-clip it. The
`.sheet` open animation uses a `transform`, but the menu only appears after the
async provider search (well after the 0.25s animation), so it anchors to the
viewport as intended. If a menu ever appears mis-placed, check for a transformed
ancestor before anything else.
