# Cover placeholders: the two silent traps in `public/js/cover.js` (#256)

Games without a cover render a deterministic per-title gradient
(`coverPlaceholder()` → `.cover-ph` in `styles.css`) instead of the old flat
`--sunken` box. Two bugs here fail **completely silently** — no console error, no
test failure, just a wall of flat boxes or repeated colours. Both cost real
effort to find; don't reintroduce either.

## 1. `--cover-h` must be UNITLESS

Inside relative colour syntax — `oklch(from var(--brand) l c calc(h + X))` — the
`h` channel is a **`<number>` of degrees, not an `<angle>`**. So:

```css
calc(h + 40deg)   /* TYPE ERROR — declaration dropped */
calc(h + 40)      /* correct */
```

A `deg` unit makes the whole `background-image` invalid, which computes to
`none`. The frame then shows its plain background and looks exactly like the
pre-#256 flat box — **with nothing in the console**. Verified in-browser:
`CSS.supports('color','oklch(from red l c h)')` is `true` while
`el.style.backgroundImage = 'linear-gradient(…calc(h + 40deg)…)'` silently
refuses to set. `test/cover.test.js` asserts the emitted value carries no unit.

Corollary for debugging: if placeholders look flat, check
`getComputedStyle(el).backgroundImage` **before** suspecting the cache. A value
of `none` means the CSS parsed and was rejected; a stale-looking rule that
otherwise applies (e.g. `position` works) means the declaration itself is
invalid, not that the file is old.

## 2. Hash the title with `Math.imul`, never `*`

`gameHue()` is FNV-1a plus a murmur3 finalizer. The FNV step **must** use
`Math.imul`:

```js
hash = Math.imul(hash ^ s.charCodeAt(i), 16777619);  // correct
hash = ((hash ^ s.charCodeAt(i)) * 16777619) >>> 0;  // WRONG
```

The prime is ~2^24 and the accumulator ~2^32, so a plain `*` lands past 2^53 and
loses low bits to float rounding — precisely the bits `% 360` then reads. The
symptom is not a crash but a **bad distribution**: 300 titles collapsed onto 157
hues (worse than chance, which is ~203), and short titles collided outright
("Catan" and "Azul" both hashed to 0, i.e. identical covers side by side).

The murmur3 finalizer matters for the same reason: FNV-1a's low bits are its
weakest and `% 360` reads only those, so they must be avalanched into the high
bits first. `test/cover.test.js` guards the spread against the theoretical ideal
`360*(1-(1-1/360)^N)`, which is what catches a regression here — the
determinism and "these 6 titles differ" tests all still pass with a broken hash.

## Why the placeholder is a child layer, not a background on the frame

`.game-card__img` / `.gd-img` / `.vote__img` paint blurred + contained copies of
their own `background-image` via `::before`/`::after` (#181). Those pseudos use
`background-image: inherit`, so putting the gradient on the frame itself makes
them draw it a second time, blurred. Keeping it in a `.cover-ph` child sidesteps
that entirely and leaves the lazy cover loader (#198), which assigns
`el.style.backgroundImage`, untouched.

Thumbnail frames therefore need `position: relative` **and** `overflow: hidden`
so the absolutely-positioned layer is anchored and clipped to their rounded
corners — that's why those two lines were added to `.ticket__img`,
`.session-card__img`, `.result-row__img`, `.pool-thumb`, `.result-podium__img`
and `.archive-row__img`.

## Verifying a change here

The service worker serves shell CSS **cache-first**, so editing `styles.css` and
reloading keeps the stale bytes (same trap as
`.claude/rules/tabler-icon-codepoints.md`). Unregister + clear caches before
**every** re-check, then navigate fresh:

```js
(await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
(await caches.keys()).forEach(k => caches.delete(k));
```

The SW re-registers on the next load, so this is needed once per CSS edit, not
once per session.
