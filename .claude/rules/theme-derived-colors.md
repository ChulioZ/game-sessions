# Derive UI colors from the theme variables, don't hardcode them

Each round picks a design (page background + accent). The whole UI must follow
it, so `styles.css` derives every tone from two custom properties that
`applyBackground()` sets: `--page-bg` and `--brand`.

**Rule:** when styling something new, never hardcode a hex that is really "a
lighter/darker shade of the page or accent" — use `color-mix()` on the existing
variables, or one of the prepared families:

- Neutrals from the page: `--sunken`, `--sunken-soft`, `--line`, `--placeholder`.
- Accent surfaces: `--brand-dark`, `--brand-tint`, `--brand-tint-soft`,
  `--brand-edge`, `--page-glow`.
- The dark finale stage: `--stage-bg/raised/line/ink/muted/faint` (all derived
  from `--brand`, so the "curtain" matches every theme).
- Semantics (theme-independent by design): `--good`, `--warn`, `--danger`, and
  the trophy/winner family `--gold`, `--gold-deep`, `--gold-soft`, `--gold-edge`.
  Tints of these still go through `color-mix(... var(--warn/--danger) N%,
  var(--surface))`, not fixed pastels.

**Why:** the original redesign hardcoded warm tones (a brown stage, beige
placeholder icons, amber pastels). On cool themes (Blaugrau, Schiefer, Lavendel)
they clashed badly — three color worlds on one screen. The fix was exactly this
derivation; don't regress it. Category tags (`.tag--digital` etc.) and medal
silver/bronze are intentionally fixed — they encode meaning, not theme.

Also note: the page backdrop (soft accent glow + paper grain) lives entirely in
the `body` rule in `styles.css`. There is no JS texture generation anymore —
`applyBackground()` only sets/removes the two variables, and stored round
designs are just `{ type: 'theme', page, accent }` (a legacy `pattern` field in
old data is ignored).
