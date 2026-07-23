# Back dismisses a sheet (#333): the pop is async, so navigate through closeSheet

Every modal sheet (add game, link provider, move games, feedback, support) goes
through `openSheet`/`closeSheet` (`public/js/views-round-detail.js`). Since #333
a sheet is a **history entry**: opening one pushes a single URL-less marker
(`history.pushState({ …, sheet: true })`), and `router.js`'s popstate handler
gives `handleSheetPop()` first refusal — so browser/OS **Back dismisses the
sheet** instead of tearing down the screen behind it. State-only, deliberately
not `?sheet=…`: these sheets hold transient, unsaved input a reload would lose
anyway, so deep-linking one buys nothing. Two things here fail *silently* if
undone.

## 1. A success handler that navigates must pass the nav to `closeSheet(next)` — NOT call showX() on the next line

`history.back()` fires `popstate` **asynchronously**. So the old shape

```js
closeSheet();
showResults(round, session);   // WRONG since #333
```

runs `showResults` (which `pushState`s via `syncUrl`) *before* the marker's pop
arrives — the synchronous push and the queued pop interleave and corrupt the
stack (you end on the marker entry while a different view is rendered; URL and
DOM disagree). The fix is to defer the navigation until the pop has landed:

```js
closeSheet(() => showResults(round, session));   // correct
```

`closeSheet(next)` tears the sheet down, `history.back()`s to consume the
marker, and `handleSheetPop()` runs `next` **after** the pop — so the stack is
back on the underlying entry and the navigation pushes cleanly on top of it.
Every navigate-after-close site (add-game save, link-provider save,
direct-session start, move-games confirm, the add-game `dismiss` when a game was
added while open) uses this form. A plain `closeSheet()` (Escape, backdrop, ×, a
submit that doesn't navigate) is unchanged — it just pops the marker so Back
isn't needed twice.

## 2. Opening a sheet must NOT be preceded by a leading `closeSheet()`

Every `showX` sheet opener used to start with a defensive `closeSheet()`. That is
now a trap: if a sheet were already open, the leading `closeSheet()` queues an
async `history.back()`, then the new sheet opens synchronously, and the queued
pop arrives **after** it and dismisses the just-opened sheet. So the leading
calls were removed and `openSheet` tears down any already-open sheet itself
(reusing its marker, fully synchronous). Don't reintroduce a leading
`closeSheet()` before building a sheet — let `openSheet` handle the replace.

## Verifying a change here

Same as the session flow (`.claude/rules/session-flow-history.md`): the Browser
pane reports `innerWidth/innerHeight === 0`, so drive it with `element.click()`
and `history.back()` from `javascript_tool`, not pixel clicks — those fire the
real listeners and real `popstate`. Observe `document.querySelector('.sheet-backdrop')`
and `history.state.sheet` rather than trying to read the lexical globals
(`sheetHistory` is not reliably visible to the eval context; `activeSheet`
happens to be — don't depend on either). `history.back()` is async, so `await` a
short delay before asserting. Never step Back past the app's first entry
(idx 0) — it leaves the app and kills the probe with *"Inspected target
navigated or closed"*. And clear the service worker before believing any check
of a `public/js/**` change (`.claude/rules/pwa-service-worker.md`) — a stale
cached bundle makes the marker push look like it never happened.

**Related:** `.claude/rules/accessibility-contrast-and-modals.md` §2 (the focus
trap `openSheet` installs, and why every sheet must go through it — the same
"impossible to get wrong" reasoning now also carries the Back-dismissal),
`.claude/rules/session-flow-history.md` (the popstate/flow contract this shares
`router.js` with), `.claude/rules/in-app-nav-links.md` (the other family of
history verification traps).
