# Linting the frontend's shared-global-scope scripts

`public/js/*.js` are classic `<script>`s that hand-roll a "module system" over
one global scope (see `frontend-script-load-order.md`). ESLint lints each file
independently and can't see cross-file use, so plain `eslint:recommended`
mis-fires on this pattern. `eslint.config.js` handles it with a dedicated
override for `public/js/**`:

- **`globals` lists every top-level name** the scripts share (`t`, `showHome`,
  `api`, `THEMES`, …) so a use of one in *another* file isn't a `no-undef`
  error. **When you add/rename/remove a top-level `function`/`const` in
  `public/js`, update that list** or lint will (wrongly) flag it — or miss a typo.
- **`no-redeclare` is off** there: each shared name is both declared in its home
  file *and* listed in `globals`, which would otherwise collide.
- **`no-unused-vars` is `vars: 'local'`**: a top-level function used only from
  another file must not be reported as unused; unused *locals* inside functions
  still are.
- Note: ESLint can't detect the load-order trap itself (it has no cross-file
  order model) — that's still on you. What lint *does* catch here is real typos,
  `no-dupe-keys` in the `lang/*.js` tables, unreachable code, etc.

The Node backend (CommonJS) is linted with full recommended rules — real
`require`/`module` boundaries make all of them work there.

**Why:** discovered setting up the Lint CI workflow; the naive globals-whitelist
approach produced 90+ false `no-redeclare`/`no-unused-vars` errors until the
override above was added.
