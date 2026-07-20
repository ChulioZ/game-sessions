# A testable frontend helper needs its OWN small file — the coverage gate says so

To unit-test a pure helper from `public/js/**`, the file holding it gets a
`module.exports` guard and the test `require`s it:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { myHelper };
}
```

**Do not add that guard to a big view file to export one helper from it.** It
works, the tests pass — and `coverage:ci` fails.

**Why:** `npm run coverage:ci` gates on `--test-coverage-lines=90` across *all
files that got loaded*. `require`-ing a view file pulls its **entire** body into
the coverage report, and a DOM view file is almost entirely unreachable from
Node (every `show*`/`render*` function needs a document), so it lands at ~10%
lines and drags the global figure under the gate.

Measured on #281: exporting `providerMatchCover` from the ~730-line
`views-round-lookup.js` put that file in the report at **10.46% lines** and took
the project from ~98% to **87.46%** — a red `coverage` check with **every test
passing** and nothing in the test output hinting at the cause. Moving the same
three-line function to its own `public/js/lookup-cover.js` restored it to
**98.63%**.

**Rule:** a frontend helper you want to test goes in its own small,
purpose-named, dependency-free file. That is exactly why `cover.js`,
`ranking.js`, `lookup-group.js` and `lookup-cover.js` exist and all sit at ~100%
— the pattern is a **coverage constraint**, not just taste.

**Splitting one is not free** (see `token-friendly-source-files.md`) — the new
file must be wired into all four places or it breaks something silently:

1. a `<script>` tag in `public/index.html`, at the right point in the load order
   (`frontend-script-load-order.md`);
2. an entry in `SHELL` in `public/sw.js` — `cache.addAll` **rejects on a single
   404**, so a missing entry silently kills offline install;
3. a **`CACHE` bump** in `public/sw.js` (`spielwirbel-shell-vN`), since shell
   assets are served cache-first on the unbuilt path (`pwa-service-worker.md`);
4. the name in `eslint.config.js`'s `frontendGlobals`, or every *other* file
   using it trips `no-undef` (`eslint-frontend-shared-scope.md`).

`test/pwa.test.js` guards (1)+(2) by parsing `SHELL` and asserting each entry is
served. Nothing guards (3) — bump it by hand.

**Corollary for diagnosing a red `coverage` check:** when the test job is green
and only `coverage` is red, don't hunt for a missing test. Look at the per-file
table for a file that has no business being there at all — a newly `require`d
view file is the usual cause.
