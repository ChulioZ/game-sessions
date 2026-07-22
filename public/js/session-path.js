/* Spielwirbel – URL paths for the transient session-flow screens (setup,
   hot-seat voting steps, finale reveal). Pure string mapping, no DOM, in its
   own file so it can be unit-tested without dragging a view file into the
   coverage report (.claude/rules/frontend-helper-modules-and-coverage.md).

   These paths exist so browser/OS Back steps *within* the flow (#329). They are
   deliberately NOT resolvable on a cold load — the screens hold votes that only
   ever lived in memory — so router.js maps every one of them back to the round
   hub, where an abandoned draw shows up as an in-progress ticket. */

'use strict';

function sessionSetupPath(rid) {
  return `/round/${rid}/session/new`;
}

// Steps are 1-based in the URL (…/vote/1 is the first screen) while the wizard
// indexes from 0, so the address bar never reads one behind what it shows.
function sessionStepPath(rid, sid, step) {
  return `/round/${rid}/session/${sid}/vote/${step + 1}`;
}

function sessionFinalePath(rid, sid) {
  return `/round/${rid}/session/${sid}/finale`;
}

// Parse one of the paths above into { kind, rid, sid, step }, or null for
// anything else — including the results path `/round/:rid/session/:sid`, which
// is a genuinely routable view and must keep resolving to showResultsById.
// A non-numeric or zero step is null rather than step 0: a malformed URL must
// not silently drop the user at the start of someone's wizard.
function parseSessionPath(pathname) {
  const p = String(pathname || '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (p[0] !== 'round' || !p[1] || p[2] !== 'session' || !p[3]) return null;
  const rid = p[1];
  if (p[3] === 'new') return p.length === 4 ? { kind: 'setup', rid, sid: null, step: null } : null;
  const sid = p[3];
  if (p[4] === 'finale') return p.length === 5 ? { kind: 'finale', rid, sid, step: null } : null;
  if (p[4] === 'vote' && p.length === 6 && /^[1-9]\d*$/.test(p[5])) {
    return { kind: 'vote', rid, sid, step: Number(p[5]) - 1 };
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sessionSetupPath, sessionStepPath, sessionFinalePath, parseSessionPath };
}
