# The session flow owns history entries (#329) — guard the EXIT, not a path

The hot-seat wizard (setup → vote steps → finale) pushes a real history entry
per screen, so browser/OS Back steps *within* it. Those screens still can't be
rebuilt from a URL — votes live only in the `startVoting` closure until the one
POST at the end — so `router.js` grew a **flow**: `beginFlow(onPopstate, guard)`
gets first refusal on `popstate` and re-renders its own step from memory, and
anything it declines ends the flow and routes normally. A cold load registers no
flow, so `resolveRoute` maps every transient session path to the round hub.

## 1. The leave guard belongs on the flow's exit, not on the path behind it

The wizard has **two** entry points, and this is the whole trap:

| Entered from | Entry behind step 0 |
|---|---|
| the setup screen ("Session wirbeln") | `/round/:rid/session/new` |
| the abandoned-draw ticket on the Start tab | `/round/:rid` (the hub) |

The first implementation asked "am I backing out to the *setup* path?" and
confirmed there. That is correct for one entry point and **silently wrong for
the other**: resuming a draw and pressing Back at step 0 lands on the hub path,
which the handler declined, so the router ended the flow and navigated — never
consulting the guard. Every vote entered since the resume was discarded with no
prompt, which is precisely the bug #329 exists to fix, reintroduced on the path
added by the same PR.

**Rule:** `onPopstate` recognises only the entries it owns (its own session's
vote steps and finale) and treats **everything else as the exit**, calling
`confirmLeave()` there. Only *after* the leave is permitted does it special-case
the setup path (to re-render the form rather than let the router send it to the
hub). Guarding a named destination is guarding the wrong thing — new entry
points are exactly what slips past it.

The same reasoning covers the non-`popstate` exits: the top-bar home button
(`core.js`) and the wizard's own breadcrumbs go through `confirmLeave()` too,
and `beforeunload` covers reload/tab-close. Miss one and it becomes a silent
data-loss path again.

## 2. The in-wizard "Zurück" must call `history.back()`

It used to be `idx--; render()`. With steps as history entries that desynchronises
immediately: the index moves, the history position doesn't, and the next platform
Back jumps to a step the user already left. Both back affordances must be the
*same movement* — the button drives history, and `popstate` drives the index.
Forward navigation goes through `go()` → `syncUrl()`, never `history.pushState`
directly, so `swrRenderToken` and `navIndex` stay consistent.

## 3. `endFlow()` at the reveal is what makes Back from results sane

Without it, Back out of the results would replay the finale, then the last vote
card, then the one before it — 12+ entries of a wizard the user has finished.
Ending the flow when the results are revealed leaves those entries to
`resolveRoute`, which maps every transient session path to the round hub. So Back
from the results lands on the round, exactly as it did before the flow existed.

## 4. Teardown must be per-closure, or an abandoned wizard blocks reloads

`beforeunload` is registered per `startVoting` call. A closure abandoned with
votes still in it would keep answering "block the unload" forever, so the listener
is removed on **every** exit: the permitted-leave guard, and `finish()` once the
POST resolves. `saved` also has to flip in `finish()` — otherwise Back out of the
finale asks whether to discard votes that are already on the server.

## 5. The abandoned-draw ticket must not show what was drawn

The draw is secret until everyone has rated (that is the point of the hot-seat
handover). The Start tab's ticket for a `done: false` session therefore shows the
tornado icon and "n Spiele ausgelost" — **never** a cover or a title, unlike the
`done: true` "Läuft gerade" ticket right below it, which may. Two ticket kinds,
one `.ticket--live` class, opposite disclosure rules.

Note the two filters are disjoint by construction: `!s.done && !s.cancelled` for
the draft, `s.done && !s.finished && !s.cancelled` for the in-progress one. A
resumed draw that reaches `/results` flips `done` and hands off from the first to
the second on its own.

## Verifying a change here

The Browser pane reports `innerWidth/innerHeight === 0`, so `read_page` is empty
and clicks are unusable (`.claude/rules/preview-pane-paint-artifacts.md`). Drive
it with `element.click()` and `history.back()/forward()` from `javascript_tool`
instead — those fire the real listeners and real `popstate`, so they test the
actual code path — and stub `window.confirm` to exercise both the accept and the
**decline** branch. Declining is the one worth checking: it must re-push the step
and leave the user exactly where they were, votes intact.
