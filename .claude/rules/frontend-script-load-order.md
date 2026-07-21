# Frontend script load order (shared global scope)

`public/js/*.js` are plain classic `<script>`s, not modules. They share one
global scope, and each runs fully before the next (the order is the `<script>`
tags in `index.html` — roughly: i18n + languages → helpers → `core.js` →
the `views-*.js` files → `router.js` → `main.js`).

**Rule:** a top-level statement that runs at load time must not reference a
function or top-level `const`/`let` that is defined in a *later* script — it
isn't defined yet and you'll get a `ReferenceError` (or a `const`
"Cannot access … before initialization" TDZ error in the file that threw,
because its later top-level `const`s never initialize).

- Function/navigation bodies are fine: they run after all scripts have loaded.
- Defer load-time references. Example: the home button handler in `core.js`
  must be `addEventListener('click', () => showHome())`, **not**
  `addEventListener('click', showHome)` — `showHome` lives in `views-home.js`,
  which loads after `core.js`.

**Why this rule exists:** it worked as a single file (function hoisting within
one script), then broke silently when `app.js` was split into ordered files —
`core.js` threw at load, so everything after the throw (including its own later
top-level `const`s) was left uninitialized.
