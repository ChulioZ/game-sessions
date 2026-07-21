# Keep source files token-friendly for agentic editing

Agents pay tokens every time they read or edit a file. A file that must be loaded
whole for a one-line change, that hides the right spot, that repeats boilerplate,
or that has its own idiosyncratic shape makes every routine change slower and more
expensive. Keep new and changed files cheap to work with along four dimensions —
**token-first, within reason** (accept a minor human-readability cost, but never
break an existing `.claude/rules/` constraint or change runtime behavior to save
tokens):

- **Read/edit size — one file, one concern.** Prefer a file an agent can load
  whole cheaply. When a file grows to cover several *independent* concerns (each
  editable without touching the others), that is the signal to split it along
  those seams, not line count alone. A large file that is a *single* cohesive
  flow (e.g. `views-session.js`: start → vote → finale → results) or a flat data
  table (`lang/*.js`) is fine — splitting it only adds indirection. Rough smell:
  a view/router file past ~700 lines that mixes unrelated screens.
- **Locating code — make the spot findable.** Order related code together, name
  `show*`/`render*`/`parse*` functions for what they do, and keep one predictable
  shape per file so an agent greps to the edit instead of reading the whole file.
- **Verbosity — comments must carry signal.** Explain *why* (a gotcha, a
  constraint, a non-obvious choice), not *what* the next line already says. Don't
  add boilerplate that inflates every read without adding information. The current
  code already does this well — keep it that way.
- **Consistency — one shape, generalized once.** Match the established patterns so
  an agent learns the shape once and reuses it: `routes/*.js` (`'use strict'`,
  header comment, data access via `req.repo`, an `express.Router`), providers
  (`search`/`detail` + pure `parse*` exports), and the frontend `show*` view
  convention. A new file that invents its own layout costs a re-learn every visit.

**Splitting a `public/js` file is not free — respect the load order.** These are
classic `<script>`s over one shared global scope; a split adds a new file that
must be inserted in `index.html` at the right point, added to the `globals` list
in `eslint.config.js`, and kept clear of the load-order trap (see
`frontend-script-load-order.md` and `eslint-frontend-shared-scope.md`). Split
when the concern boundary is real, not reflexively by size.

**Why:** the codebase was assessed against these four dimensions (issue #38). The
backend (`routes/`, `lib/`, providers) and most frontend files were already
token-friendly. The one clear outlier was `public/js/views-round.js` (~2237
lines spanning ten unrelated screens — a one-line change forced loading
everything). It has since been split along its real seams into `views-round.js`
(hub + Start), `views-round-tabs.js`, `views-round-detail.js` and
`views-round-lookup.js`; this rule keeps future files from regrowing the
pattern.
