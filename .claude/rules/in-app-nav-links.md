# In-app navigation is `<a href>` (#330) — and a synthetic click cannot test it

Every route-changing control is a real anchor built by `navLink(el, path, onNav)`
(`public/js/nav-link.js`): the href is what the browser needs, and only a *plain*
left-click is swallowed and routed in-app. Three things about this are
load-bearing and one of them will waste an afternoon if you don't know it.

## 1. The verification trap: `dispatchEvent` ignores modifier keys

The whole feature is "a Cmd/Ctrl/middle-click must reach the browser". The
obvious probe —

```js
el.dispatchEvent(new MouseEvent('click', { metaKey: true }));   // WRONG
```

— **does not test that.** Chrome honours the modifier flags when *dispatching*
the event (so `e.metaKey` is true and `navLink` correctly declines to
`preventDefault`), but its **default action for a synthetic click on an anchor
ignores them entirely**: instead of opening a new tab it performs a full
same-tab navigation. So the probe tears the page down, `window.__marker`-style
state vanishes, and the next `javascript_tool` call fails with *"Inspected
target navigated or closed"* — which reads exactly like the app crashing.

Probe the **decision**, not the outcome. Attach a listener at `document` (bubble
phase, so it runs after the anchor's own handler and after any row handler
behind it) that records `e.defaultPrevented` and then blocks the browser:

```js
const seen = [];
const sink = (e) => { seen.push(e.defaultPrevented); e.preventDefault(); e.stopImmediatePropagation(); };
document.addEventListener('click', sink, false);
// swallowed === true  -> navLink took it, the SPA routes in-app
// swallowed === false -> left to the browser, i.e. new tab / new window
```

Two follow-on habits:

- **Probe every modified click BEFORE any plain one.** A plain click re-renders
  `#app`, detaching every node you were holding — subsequent `querySelector`s
  return the *new* tree and any element reference you captured is dead. The
  symptom is a result object where half the keys are missing, not an error.
- **`window.*` cannot wrap the view functions.** `showGameDetail`, `showRetired`
  &c. are top-level `const`/`function` in a classic script, so they live in the
  script's global *lexical* scope, **not** on `window` — assigning
  `window.showGameDetail = wrapper` silently creates a new, unread property and
  your call counter stays at zero. Count `history.pushState` instead (a real
  object method every navigation goes through via `syncUrl`); that is also what
  reveals a double-navigation.

## 2. `.nav-link` must sit EARLY in styles.css

`navLink` adds a `nav-link` class carrying `color: inherit; text-decoration: none`
— an anchor otherwise arrives browser-blue and underlined, which none of these
components (cards, tabs, tickets, breadcrumbs) ever wanted.

It is declared **before** the component rules on purpose. It is a plain class
selector, so it ties on specificity with `.link-btn`, `.ticket`, `.dock__item`
&c. and **source order decides**: placed early, a component that names its own
`color` still wins, while a component that names none inherits instead of
turning blue. Move the rule to the bottom of the file and every accent-coloured
link-button silently goes ink-black. (`text-decoration` has no such competition
— the `:hover` underline rules are more specific and keep working.)

## 3. A `<button>` inside an `<a>` is invalid — so the row keeps its handler

The Chronik activity row (`.tl-act`) holds a delete button, so the row itself
cannot become an anchor. Only `.tl-act__text` does, and the row keeps its own
click handler for the generous target around it. That combination has one trap:

**a modified click on the anchor bubbles to the row handler.** The anchor
correctly lets the browser open a new tab — and then the row handler navigates
*this* tab too, so the user gets both. The guard is an explicit bail-out in the
row handler (`if (ev.target.closest('.tl-act__text')) return;`), not a
`defaultPrevented` check: `defaultPrevented` is false for exactly the modified
clicks that need excluding.

## Smaller things worth keeping

- **The active hub tab gets an href but no `onNav`.** It stays click-inert (a
  real navigation there would be a full page reload of the screen you are on)
  while remaining copyable and openable in a new tab.
- **`makeGameLink`/`makeMemberLink` now REQUIRE an anchor.** They dropped the
  hand-rolled `role="button"` + `tabindex="0"` + Enter/Space handling — an
  `<a href>` is focusable and Enter-activated natively. Space no longer
  activates them, which is correct link semantics. If you point either helper at
  a `<span>` or `<div>` it will set an `href` that does nothing: the element is
  not focusable, has no link semantics, and only the JS click survives.
- **An `<a>` with no href is not a link** — not focusable, not styled, no
  affordance. So a shared builder must emit a `<span>` when it has no target
  (see `statCard`'s `linkMid` parameter in `views-round-tabs.js`) rather than an
  anchor that some callers happen to fill in later.
- **Path builders live in `router.js`** (`roundPath`, `gamePath`, `memberPath`,
  `resultsPath`), next to `resolveRoute`, so a view's `syncUrl` and the links
  pointing at it cannot drift. The *transient* session-flow paths stay in
  `session-path.js` — they are deliberately unresolvable, so they are not link
  targets and must stay buttons (the abandoned-draw ticket, "Session wirbeln").
- **Sheets and actions stay buttons**: add game, link provider, move games,
  feedback, support, the rating faces, retire/complete. If it has no URL the
  router resolves, it is not a link.

**Related:** `.claude/rules/preview-pane-paint-artifacts.md` (the other family
of "the pane is lying to you" verification traps),
`.claude/rules/frontend-helper-modules-and-coverage.md` (why `nav-link.js` is
its own file), `.claude/rules/session-flow-history.md` (the `popstate`/flow
contract these links navigate within).
