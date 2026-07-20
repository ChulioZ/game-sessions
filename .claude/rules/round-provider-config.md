# Per-round lookup providers (#294): absent ≠ empty, and the lookup is round-scoped

A round's `providers` field lists which lookup providers it queries. Two things
about it are load-bearing and fail *quietly* if undone.

## 1. ABSENT means "all providers" — never give it a default

Three states, not two:

| Stored value | Meaning |
|---|---|
| key **absent** / column NULL | never configured → **all five providers** (pre-#294 behaviour) |
| `["bgg", "steam"]` | exactly those |
| `[]` | **query nothing** — a real setting ("we type our own titles"), not an error |

So a "harmless" tidy-up — defaulting the column to `'[]'`, writing
`providers: []` in `createRound`, or making the frontend read
`round.providers || []` — silently switches **every existing round's** lookup
off. Nothing throws; the dropdown just stops appearing, which reads as "the
lookup broke" rather than "someone changed a default". `enabledProviders()`
(`public/js/views-round-lookup.js`) is the single place that decodes the absent
case on the client; the server does it inline in `resolveProvider()`
(`routes/lookup.js`). Both check `Array.isArray`, deliberately — not
truthiness, which would fold `[]` back into "all".

The contract suite pins all three states down in both backends, including that a
fresh round grows **no** `providers` key. Absent-key parity is the usual
JSON-vs-Postgres constraint (see `.claude/rules/postgres-backend.md`), and
`providers` is an **array**, so the Postgres write must `J()` it — a raw array
binding into `jsonb` throws `22P02`.

## 2. The lookup moved under the round, because the setting has to be ENFORCED

`/api/lookup/*` became **`/api/rounds/:rid/lookup/*`** (mergeParams). It had to
move: which providers may be queried is per-round, so the route needs the round
to check it, and a disabled provider gets a **403 `provider_disabled`** rather
than an answer.

Filtering only the client's fan-out would leave the setting advisory — a stale
tab or a hand-rolled call would still reach the provider, which defeats the
"stop making four useless upstream requests" half of the feature. The 403 also
keeps the failure legible: an unknown id stays a **400**, a missing round a
**404**, a disabled-but-registered provider a **403**. `test/providers.test.js`
asserts the disabled case never reaches `fetch` at all.

## Smaller things worth keeping

- **Zero providers → `attachLookup` returns inert stubs** (`closeMenu`/`search`
  no-ops) and binds no listeners, rather than attaching a lookup that can never
  produce a hit. Callers still call both unconditionally — `showLinkProvider`
  calls `search()` immediately on open.
- **`.provider-row .ds-row__main` is scoped for a reason.** `.ds-row__main` had
  no flex rule; the Chronik rows rely on it stacking a date over a status.
  Making it a global flex row lays those out side by side.
- **`ti-world-search` (`\f9e7`) was added to the font subset** and verified
  against this bundle's own cmap, not tabler.io — see
  `.claude/rules/tabler-icon-codepoints.md`. It sits in the CJK Compatibility
  Ideographs block, which is normal for this bundle.
