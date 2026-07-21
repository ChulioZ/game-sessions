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
`tabler-icons.css` a plain reload keeps the stale bytes. Unregister the SW and
clear its caches before re-checking — snippet in
`.claude/rules/pwa-service-worker.md` ("Verifying a shell-asset change").

## A `ti-*` class in the markup does NOT mean it's declared

Because the subset only declares the classes someone remembered to add, an
`<i class="ti ti-foo">` whose rule is **missing** renders **nothing at all** —
no tofu, no console warning, no lint error, no failing test. It just silently
occupies zero-ish width, and the label next to it still reads fine, so the UI
looks merely "plain" rather than broken.

Found on #282: `.ti-link` and `.ti-external-link` had been used on the game
detail screen since #74 (the "View on X" / "Link to provider" actions) but were
**never added to the CSS**, so both had been invisible in production the whole
time. Running the grep below then turned up **five more** in the same state —
`ti-heart`, `ti-percentage` (Pokale cards) and `ti-lock-question`,
`ti-mail-check`, `ti-logout` (the account/auth screens). All eight are declared
and cmap-verified as of #282.

Note two of them, `\f931` and `\f939`, sit in the **CJK Compatibility Ideographs**
block rather than the Private Use Area — that is fine and not a sign of a wrong
lookup (this bundle maps glyphs above U+F900), but it does mean the codepoint
prints as a CJK character in a console dump. Judge those by the rendered glyph,
not by how the `content` string looks in devtools.

**So when you add an icon, also grep the class you're copying from:**

```bash
grep -o '^\.ti-[a-z0-9-]*' public/fonts/tabler-icons.css   # what's declared
grep -rho 'ti-[a-z0-9-]*' public/js public/*.html | sort -u # what's used
```

A name in the second list but not the first is an already-invisible icon.
