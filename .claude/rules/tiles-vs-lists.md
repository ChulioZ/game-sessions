# Tiles vs lists: decide by the CONTENT, not by how much room is left over

Wide screens make every full-width row look wasteful, so the reflex once the
desktop rail landed was "tile everything". Two screens were converted and three
deliberately were not, and the line between them is not about available width:

| Tile it | Keep it a list |
|---|---|
| entries are **unordered** | order carries meaning |
| entries are **short** (a chip, a name, a toggle) | entries are rich (cover, stats, several actions) |
| you scan for one entry | you read the sequence |
| tags, providers, the round lobby, the Regal | session results, the Chronik, a game's related sessions |

**The ordering half is the one that actually bites.** A grid is read
left-to-right and then wrapped, so putting a *ranking* in one makes rank 3 sit
to the right of rank 2 and rank 4 below rank 1. The session results screen
exists to communicate an order — podium, then rows sorted by rating — so tiling
its rows would destroy the one thing it is for, while looking tidier. Same for
the Chronik: a month-grouped timeline read in columns is not a timeline.

**The richness half is about the meta half of a row.** `.ds-row` puts its
`__main` and `__meta` at opposite ends, which is exactly right at 900px for a
*short* entry — and exactly wrong at 900px for a short one on a wide screen,
where it strands a tag's count and buttons ~700px from the tag. Tiling fixes
that by shrinking the line, not by changing the row. A rich row already fills
its width, so it has nothing to gain.

## How to tile, in this codebase

`.ds-list--tiles` (a modifier on `.ds-list`, never a change to it — the related
sessions list shares that component and must stay a list):

```css
.ds-list--tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.ds-list--tiles .ds-row { flex-wrap: wrap; row-gap: 10px; }
.ds-list--tiles .ds-row__main { min-width: 0; }
```

Three things about that are load-bearing:

- **`auto-fill`, so it needs no breakpoint.** 1 column on a phone, 3 at 1279, 5
  in the desktop pane. Don't add a media query; don't switch to `auto-fit`
  (which collapses empty tracks and lets a lone tile balloon).
- **The row must be allowed to WRAP.** `.ds-row` is a nowrap flex line sized for
  a 900px width, so in a 280px tile the tag rows pushed their edit/delete
  buttons out through the right edge, where they were **clipped and
  unclickable** — visible only as a slightly odd screenshot, with every test
  green. Wrapping also lets each list find its own shape without a per-list
  rule: providers keep logo/name/checkbox on one line, a tag drops its count
  and actions to a second.
- **A tiled list must join the width exemption** in the `>= 1280px` block
  (`.app > *:is(…)` / `:has(…)`), or the tiles stay boxed in the `--w-read`
  reading measure and you get three columns where five fit.

## Screens deliberately left alone (2026-07-22)

Re-deciding these costs a browser session each; the reasoning is here so it
doesn't have to be redone.

- **Session results** — a ranking (see above). The podium is a centred hero
  band; moving it beside the rows saves ~250px of scroll at the cost of
  squeezing it and breaking the reveal-then-detail flow.
- **Member** — already uses the pane: the five stat cards span it (they are
  `.pokale-cards`, already exempt) while identity and the colour picker keep
  the reading measure. At 900px those cards are ~170px and labels like
  "Ø vergebene Wertung" wrap badly; at ~280px they read cleanly. The resulting
  raggedness (a full-width stats band under narrower sections above) is
  deliberate and reads as a band, not as a mistake.
- **Game detail** — the defect there was a *sizing* one, not a shape one: the
  score ring sat 453px from the title because `.gd-info` was `flex: 1`. Fixed
  by `flex: 0 1 auto` plus `width: fit-content` on `.gd-head`. A full
  two-column restructure would need the view rebuilt (cover and facts live
  inside one `.gd-head`, the rest are flat siblings of `.app`) to turn a
  ~550px-tall page into a ~400px one.
- **The two archives** (`.archive-list` / `.archive-row`, retired and
  completed) — they look like the next tiling candidate after tags and
  providers, and they are not: a row carries a cover thumb, a title, a
  timestamp and two buttons, so it is *rich* by the table above, and the list
  is ordered by when each game was archived. Both halves of the rule point the
  same way. They keep the reading measure.
- **Chronik** — a month-grouped timeline, i.e. the ordering case in its purest
  form. It stays a list at the reading measure, and that is the settled answer
  rather than a deferral (operator decision, 2026-07-23).

The last two were named in **#332**'s scope ("the grid/row density of the
list-type views … the Chronik timeline rows … and the archive rows"), and its
open questions asked what the desktop Chronik should show with the extra width
— "more metadata per row, or a denser two-column timeline". That question is
answered here: neither. Nothing about #332 remains open; don't re-open it on
the strength of that line.

**Related:** `.claude/rules/responsive-content-width.md` (the pane the tiles
live in, and why its width may key off the viewport only),
`.claude/rules/css-text-assertions-strip-comments.md` (how the guarding test
parses the stylesheet).
