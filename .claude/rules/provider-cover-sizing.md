# Provider covers are print-resolution masters — size them at RENDER time (#298)

Since #172 a provider cover is hotlinked, so `game.image` holds whatever URL the
provider handed us. For Sony and Microsoft that is the **full master**, and the
numbers are not marginal — measured live on 2026-07-20:

| Provider | Stored URL | Bytes | Decoded |
|---|---|---|---|
| BGG | `…/fit-in/246x300/…` | ~20 KB | small |
| Steam | `…/capsule_231x87.jpg` | ~50 KB | small |
| Nintendo | `nintendo.com/…` | ~100 KB | medium |
| **Xbox** | `store-images.s-microsoft.com/…` | **207–837 KB** | large |
| **PS Store** | `image.api.playstation.com/…` | **1.0–1.7 MB** | **3840×2160** |

`public/js/cover-size.js` → `coverUrl(image, width)` rewrites those two hosts to
a sized variant at every render site. A 14-game PS shelf went **13,196 KB → 239
KB (55×)**, i.e. ~17 KB/cover — the same order as a BGG shelf.

## The finding that explains the symptom: decode memory, not download

The reported bug was *scroll jank*, and the tempting culprit was the blurred
`::before` backdrop (`styles.css`, #181). It was a symptom. A PS master is
**3840×2160 = 8.3 MP = 31.6 MB of decoded RGBA per cover**; the sized variant is
504×284 = **0.29 MB**. A 14-card shelf therefore held ~442 MB of decoded bitmap
before this change and ~4 MB after — **108× fewer pixels**.

So don't "fix" the blur layer. The blur was expensive only because it operated
on an 8.3 MP source; at 0.08 MP it is free, and the `::before`/`::after`
`background-image: inherit` structure (which
`.claude/rules/deterministic-cover-placeholders.md` explains) stays untouched.
If cover jank is ever reported again, **measure `naturalWidth × naturalHeight`
first** — that number, not transferSize, is what predicts it.

## Three things that are load-bearing

- **The "already has a query string" guard is not hypothetical.** The Xbox
  *search* hit's thumbnail already arrives as `?w=150&h=150` (the *detail*
  `imageUrl` is the bare master). Appending a second `w=` would produce a
  malformed query. It is also what lets a future capture-time change coexist.
- **Only add a host after checking its CDN honours the parameter.** Nintendo's
  ignores `?w=` — the response is byte-identical — so listing it would add noise
  and no benefit. BGG and Steam are already right-sized. An unrecognised host
  passing through untouched is the safe default, and own uploads
  (`/uploads/<key>`) must pass through byte-identically since we serve those
  ourselves and have no resizer.
- **It must be render-time, not capture-time.** This repo keeps no permanent
  migration code (CLAUDE.md), so rewriting what `pickImage()` stores would fix
  only games added afterwards and leave the whole existing corpus slow. On
  render, every already-linked game is fixed on its next load and the stored
  value stays the provider's canonical URL.

## The server guard needs no change — but verify it

`providerCoverUrl()` (`lib/providers/index.js`) rejects `'`, `"`, `(`, `)`,
backslash and whitespace, because `game.image` is interpolated into
`background-image:url('…')`. `?w=330&h=330&q=90` contains none of them.
`test/cover-size.test.js` asserts this rather than assuming it, so a future
resizer whose query needs an unsafe character fails loudly instead of opening a
CSS-injection hole.

## Verifying it in the preview pane

The Regal grid's covers are lazy (`createCoverLoader`, #198), and the Claude
Code Browser pane reports **`window.innerHeight === 0`**, so its
IntersectionObserver **can never fire** and every grid cover stays blank no
matter how you scroll. That looks exactly like a broken lazy loader. It isn't —
it is the pane artifact family documented in
`.claude/rules/preview-pane-paint-artifacts.md`, and `resize_window` does not
fix it.

Verify instead via a path that doesn't depend on the observer:
- the **game-detail hero** and the **voting screen** set `background-image`
  inline, so they exercise the real render path immediately; or
- apply what `loadCover` would apply yourself, then read
  `performance.getEntriesByType('resource')` and assert every provider request
  carries the expected `?w=`.

Also unregister the service worker and clear its caches first — the shell is
served cache-first, so a stale `cover-size.js` will silently hide your change.
