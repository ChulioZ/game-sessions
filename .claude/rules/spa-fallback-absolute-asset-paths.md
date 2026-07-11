# SPA fallback needs root-absolute asset paths in index.html

The server serves `public/index.html` for any non-`/api`, non-static frontend
GET (the client-side router then renders the view — see `lib/app.js` and
`public/js/router.js`). This makes deep links like `/round/:rid/regal` work.

**Trap:** with that fallback in place, **relative** asset URLs in `index.html`
(`href="styles.css"`, `src="js/core.js"`) break on any nested route. On
`/round/:rid/regal` the browser resolves `js/core.js` to
`/round/:rid/js/core.js`, which doesn't exist as a static file, so the fallback
returns `index.html` (HTML) with a 200. Every `<script>`/`<link>` then loads
HTML instead of JS/CSS → nothing executes, a blank page, and *no* console error
that points at the cause.

**Rule:** all asset references in `index.html` must be **root-absolute**
(`/styles.css`, `/js/…`, `/fonts/…`), not relative, so they resolve the same
from any route depth. (Assets referenced *inside* a CSS file are relative to
that file's own `/fonts/` URL, so those are fine.)

**Why:** discovered implementing client-side routing (issue #36). The symptom is
a completely blank nested-route page with an empty console; the fix is one
character (`js/…` → `/js/…`) per reference.
