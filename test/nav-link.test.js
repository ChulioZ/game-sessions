'use strict';

/* In-app navigation links (#330).
 *
 * navLink() is what makes every route-changing control a real <a href> while
 * keeping the SPA's no-page-load navigation. The whole feature turns on which
 * clicks it swallows and which it hands to the browser, so that is what these
 * assert — with a hand-rolled element/event stub, because the helper touches
 * only classList/setAttribute/addEventListener and pulling in a DOM library for
 * three methods would be more machinery than the thing under test. */

const test = require('node:test');
const assert = require('node:assert');

const { isPlainClick, navLink } = require('../public/js/nav-link');

// Minimal stand-in for the anchors the views build: records what navLink did to
// it and lets a test fire a click through the listener navLink actually bound.
function anchor() {
  const listeners = {};
  const el = {
    classes: [],
    attrs: {},
    setAttribute: (k, v) => { el.attrs[k] = v; },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    fire: (type, event) => (listeners[type] || []).forEach((fn) => fn(event)),
  };
  el.classList = { add: (c) => el.classes.push(c) };
  return el;
}

// A click event as the browser reports it: primary button, no modifiers, unless
// overridden.
function clickEvent(over) {
  const e = {
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    defaultPrevented: false,
    preventDefault() { e.defaultPrevented = true; },
  };
  return Object.assign(e, over);
}

test('isPlainClick: only an unmodified primary click belongs to the SPA', () => {
  assert.equal(isPlainClick(clickEvent()), true);
  // Each of these is a user asking the BROWSER to open the destination. Letting
  // any one of them through to preventDefault() is the bug #330 exists to fix.
  assert.equal(isPlainClick(clickEvent({ metaKey: true })), false, 'Cmd+click');
  assert.equal(isPlainClick(clickEvent({ ctrlKey: true })), false, 'Ctrl+click');
  assert.equal(isPlainClick(clickEvent({ shiftKey: true })), false, 'Shift+click');
  assert.equal(isPlainClick(clickEvent({ altKey: true })), false, 'Alt+click');
  assert.equal(isPlainClick(clickEvent({ button: 1 })), false, 'middle-click');
  assert.equal(isPlainClick(clickEvent({ button: 2 })), false, 'right-click');
});

test('navLink sets a real href and the shared nav-link class', () => {
  const el = anchor();
  navLink(el, '/round/r1/game/g1', () => {});
  assert.equal(el.attrs.href, '/round/r1/game/g1');
  assert.ok(el.classes.includes('nav-link'));
});

test('navLink returns the element, so a call site can build and wire in one go', () => {
  const el = anchor();
  assert.equal(navLink(el, '/', () => {}), el);
});

test('a plain click routes in-app instead of reloading the page', () => {
  const el = anchor();
  let navigated = 0;
  navLink(el, '/round/r1', () => navigated++);
  const e = clickEvent();
  el.fire('click', e);
  assert.equal(navigated, 1);
  assert.equal(e.defaultPrevented, true, 'the browser must not also navigate');
});

test('a modified or middle click is left entirely to the browser', () => {
  // This is the acceptance criterion of the whole issue: open-in-new-tab only
  // works if the handler neither preventDefaults nor routes this tab away.
  for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    const el = anchor();
    let navigated = 0;
    navLink(el, '/round/r1', () => navigated++);
    const e = clickEvent(over);
    el.fire('click', e);
    assert.equal(navigated, 0, `should not route in-app: ${JSON.stringify(over)}`);
    assert.equal(e.defaultPrevented, false, `should not preventDefault: ${JSON.stringify(over)}`);
  }
});

test('without onNav the link is inert on a plain click but still a real URL', () => {
  // The active hub tab: copyable and openable in a new tab, but clicking it
  // must not reload the screen you are already on.
  const el = anchor();
  navLink(el, '/round/r1/regal');
  assert.equal(el.attrs.href, '/round/r1/regal');
  const e = clickEvent();
  assert.doesNotThrow(() => el.fire('click', e));
  assert.equal(e.defaultPrevented, true);
});
