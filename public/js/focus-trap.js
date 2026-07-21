/* Spielwirbel – focus containment for modal sheets (issue #145).

   Its own small, dependency-free file so the test suite can require it — see
   .claude/rules/frontend-helper-modules-and-coverage.md (exporting it from a
   view file would drag that file's unreachable DOM code into the coverage
   report and sink the 90% gate).

   Why it exists: every sheet is `role="dialog" aria-modal="true"`, which
   constrains a *screen reader* — but nothing constrained the *keyboard*. With a
   sheet open, Tab walked straight out of it into the page behind the backdrop,
   focusing controls the user cannot see. And closing a sheet dropped focus to
   <body>, so a keyboard user restarted from the top of the document every time. */

'use strict';

// Elements that can hold focus. `:not([tabindex="-1"])` keeps out the honeypot
// input and anything deliberately taken out of the tab order.
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Visible, focusable descendants of `root`, in DOM order — which is tab order
// here, since nothing in the app sets a positive tabindex.
function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.closest('[aria-hidden="true"]')) return false;
    // offsetParent is null for display:none subtrees; position:fixed elements
    // report null too, hence the rect fallback (the lookup menu is fixed).
    if (el.offsetParent !== null) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  });
}

/* Contain Tab within `container` until the returned release() is called.
   Restores focus to whatever was focused at trap time — normally the control
   that opened the sheet — so closing returns the user where they were.

   The handler runs on the CAPTURE phase so it wins over anything inside the
   sheet, and it only ever acts on Tab: every other key, including the Escape
   the sheets already handle, passes through untouched. */
function trapFocus(container) {
  const restoreTo = document.activeElement;
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = focusables(container);
    if (!items.length) {
      // Nothing to focus inside: keep focus on the dialog rather than letting
      // Tab escape to the page behind the backdrop.
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    // Focus outside the container (or on the container itself) means the
    // browser is about to leave it — pull it back to the correct edge.
    const active = document.activeElement;
    if (!container.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);

  return function release() {
    document.removeEventListener('keydown', onKey, true);
    // Only restore if the element is still in the document and still focusable;
    // a sheet that replaced the view underneath it has no opener to go back to.
    if (restoreTo && document.contains(restoreTo) && typeof restoreTo.focus === 'function') {
      restoreTo.focus();
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { trapFocus, focusables, FOCUSABLE };
}
