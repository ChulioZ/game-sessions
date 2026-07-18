# Preview-pane blank screenshots & scroll timeouts are (often) not app bugs

Discovered verifying #198 (lazy covers + `content-visibility`): in the Claude
Code Browser pane, the app's Regal grid produced **blank screenshots after any
programmatic scroll** (`scrollTo`/`scrollBy`), and `computer` **scroll/input
actions timed out after 30s** — which looks exactly like a layout/paint loop
caused by the change under test (`content-visibility: auto` is a prime suspect).

It wasn't. The control experiments that proved it:

- The same blank capture happened with the suspect CSS **disabled** (injected
  `content-visibility: visible !important` override).
- Input scrolls timed out on the **untouched Home page** too.
- Page JS stayed fully responsive the whole time (`javascript_tool` probes),
  no console errors, and DOM/layout numbers (rects, `scrollHeight`, computed
  grid columns) were correct at every probe.
- A **fresh `navigate` always painted correctly** — the artifact only appeared
  on captures after programmatic scrolls in the same page instance.

**Rule:** before blaming the change, run those controls. Verify scroll-dependent
behavior in the preview pane with **JS probes, not pixels**: element rects,
`document.scrollHeight`, `performance.getEntriesByType('resource')` /
`read_network_requests` counts (e.g. lazy-load = N requests at top, more after
`scrollBy`). Take screenshots only right after a fresh navigation. A capture
that's blank while the DOM probes are healthy is the pane, not the app.

This extends the CLAUDE.md note about non-painted preview tabs and rAF: the
pane can also fail to produce fresh frames after synthetic scrolls, and its
input pipeline can wedge per-session (a reload/re-navigate recovers painting;
input may stay broken) — while the page itself is fine in a real browser.
