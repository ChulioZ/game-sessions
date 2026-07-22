# Strip comments before matching selectors in a CSS-text test

Several tests assert against `public/styles.css` as a **string** rather than a
parsed stylesheet (`a11y-contrast.test.js`, `cover.test.js`, and since #324
`dock-footer-clearance.test.js`). That is the right tool at this size — but a
selector regex written the obvious way will silently match **inside a CSS
comment**, because a comment is brace-free text and every practical selector
pattern is built out of `[^{}]*`.

Concretely, a rule-matching regex like

```js
/(?:^|})\s*([^{}]*\.dock[^{}]*\.site-footer[^{}]*)\s*{([^}]*)}/m
```

happily spans a comment that merely *mentions* `.dock` in prose and then binds
to whatever unrelated rule opens next — in #324 that was the comment above the
fix plus the neighbouring `.site-footer__links {` selector.

**Why this is worse than a normal flaky regex:** the false match makes the test
pass against a stylesheet where the thing it guards has been **deleted**. Caught
only because the fix was removed on purpose to watch the probe fail (the
discipline `.claude/rules/admin-moderation-surface.md` §3 prescribes) — one
assertion stayed green against the broken file. A test whose whole job is to
catch a silent visual regression, silently not catching it, is the worst
possible outcome.

**Rule:** strip comments first, then match:

```js
const CSS = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
```

Two follow-on habits from the same bug:

- **Tokenize into `[selector, body]` pairs once** and look rules up by exact
  selector, instead of writing a bespoke regex per assertion. One parse, no
  per-test escaping mistakes.
- **Match a class as a whole class.** `.site-footer` naively also matches
  `.site-footer__links` and `.site-footer__bgg`; this codebase's BEM-ish naming
  makes that collision the norm, not the exception. Use a trailing guard:
  `/\.site-footer(?![\w-])/`.

And always break the production code on purpose once to confirm the assertion
actually goes red — a CSS-text test gives you no other signal that it is wired
to anything real.
