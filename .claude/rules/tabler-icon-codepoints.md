# Adding a Tabler icon: map the codepoint from the bundled font, not upstream

`public/fonts/tabler-icons.css` is a **curated subset** — only the `.ti-X::before
{ content: "\hhhh"; }` lines the app actually uses are declared, though the
committed `tabler-icons.woff2` holds the **full** glyph set (~5000 glyphs). To use
a new icon you add one line with its codepoint.

**The trap (cost real effort on #241):** the codepoints in *this* bundled woff2
do **not** always match the numbers in the public `tabler.io` / upstream
`tabler-icons.css`. Copying a codepoint from the website can land on a
*different* glyph. Concretely, `ti-ban` is `\ea2e` in this bundle, but `\eb43`
(the value some references give) is `trending-up` here — the chip rendered a
diagonal arrow instead of a prohibition sign, and it looked fine to every check
except the eye.

**Two-step verification before trusting a codepoint:**

1. Confirm the glyph is in the woff2 **and** get its real codepoint from the
   font's own cmap (glyph *names* → codes), not an external list:

   ```bash
   python3 - <<'PY'
   from fontTools.ttLib import TTFont           # pip install fonttools brotli
   cmap = TTFont("public/fonts/tabler-icons.woff2").getBestCmap()  # code -> glyphName
   for code, name in sorted(cmap.items()):
       if name == "ban": print(hex(code))       # -> 0xea2e
   PY
   ```

2. After adding the `.ti-X::before` line, **look at the rendered glyph** in a real
   browser — a wrong-but-present codepoint renders a plausible *other* icon with
   no error, so a screenshot is the only thing that catches it. A missing glyph
   shows as tofu / zero width; a wrong glyph shows as the wrong picture.

**Also:** the service worker serves shell CSS **cache-first**, so after editing
`tabler-icons.css` a plain reload keeps the stale bytes (even `fetch(...,
{cache:'reload'})` — the SW intercepts). To verify an icon change in the preview,
unregister the SW and clear its caches first:

```js
(await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
(await caches.keys()).forEach(k => caches.delete(k));
// then navigate again
```

See also the `tabler-glyph-and-icon-regen` memory note and
`.claude/rules/pwa-service-worker.md` (cache-first shell assets).
