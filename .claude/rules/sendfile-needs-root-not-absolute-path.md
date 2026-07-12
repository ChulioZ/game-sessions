# res.sendFile must use a `root` option, not an absolute path

The SPA fallback in `lib/app.js` serves `public/index.html` for frontend deep
links. It must call:

```js
res.sendFile('index.html', { root: path.join(ROOT, 'public') });
```

**not** `res.sendFile(path.join(ROOT, 'public', 'index.html'))`.

**Why:** Express's `res.sendFile` (via the `send` library) rejects with a bare
`404 Not Found` **any path segment that starts with a dot** (`send`'s default
`dotfiles: 'ignore'`). With an *absolute* path, `send` scans the **whole** path,
including the directory prefix. So when the app runs from a checkout whose path
contains a dot-segment — e.g. a Claude Code worktree under
`…/.claude/worktrees/<name>/…` — every deep link 404s even though
`public/index.html` clearly exists (`fs.existsSync` is true). With the `root`
option, `send` only checks the *relative* part (`index.html`) for dotfiles, so
the `.claude` prefix is irrelevant.

**Trap this caused:** `test/spa-fallback.test.js` failed **only in the worktree**
(deep-link tests got 404), passed on CI and in the normal `game-sessions/`
checkout. It's easy to misattribute this to the Node version (a very new local
Node vs. CI's LTS) — it is **not** Node-related at all; it's purely whether the
absolute filesystem path contains a dot-segment. If a "works on CI / normal
checkout, fails locally in the worktree" file-serving 404 shows up, check for a
dotfile in the path before blaming Node or Express versions.
