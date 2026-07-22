/* Spielwirbel – in-app navigation as real links (#330).

   Every route-changing control in the SPA used to be a <button> (or a
   role="button" div), so Cmd/Ctrl/middle-click did nothing, right-click offered
   no "Copy link address", the browser previewed no destination on hover, and
   assistive tech announced a nameless button instead of a link. The
   destinations were never the problem — router.js has resolved them all along;
   they simply weren't on the elements.

   navLink() puts the path on a real <a href> and intercepts ONLY a plain
   left-click, so the SPA still swaps views with no page load while every
   browser affordance built on top of href keeps working.

   Pure and dependency-free (no DOM queries, no i18n, no views) so the test
   suite can require it without dragging a view file into the coverage report —
   see .claude/rules/frontend-helper-modules-and-coverage.md. */

'use strict';

// A click the browser should handle itself rather than the SPA: any modifier a
// user could mean "open this somewhere else" by, or a non-primary button.
// Middle-click is the reason `button` is checked at all — modern browsers route
// it to `auxclick` and never fire `click`, but older ones fired `click` with
// button 1, and swallowing that would break the very affordance this exists for.
function isPlainClick(e) {
  return (
    e.button === 0 &&
    !e.metaKey && // Cmd+click — new tab on macOS
    !e.ctrlKey && // Ctrl+click — new tab on Windows/Linux
    !e.shiftKey && // Shift+click — new window
    !e.altKey // Alt/Option+click — download the target
  );
}

// Turn `el` (an <a>) into an in-app link to `path`: a real href for the
// browser, `onNav` for a plain left-click.
//
// Omitting `onNav` makes the link inert on a plain click while staying a real,
// copyable, new-tab-able URL — that is the active hub tab, which points at the
// screen you are already on and must not reload the page.
//
// The `nav-link` class carries the styling every one of these needs: an anchor
// arrives with a UA underline and link colour that none of the components it
// replaces ever wanted (see styles.css).
function navLink(el, path, onNav) {
  el.classList.add('nav-link');
  el.setAttribute('href', path);
  el.addEventListener('click', (e) => {
    if (!isPlainClick(e)) return; // let the browser open its tab/window
    e.preventDefault();
    if (onNav) onNav();
  });
  return el;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isPlainClick, navLink };
}
