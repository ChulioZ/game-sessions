'use strict';

/* The focus trap behind the modal sheets (#145). Exercised against a tiny hand
   rolled DOM rather than a real one: the module only needs querySelectorAll,
   contains, focus and a keydown listener, so a stub keeps the test dependency
   free (supertest is the only test dep) and pins the exact behaviour — which
   element gets focus on each Tab, and that focus returns to the opener. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { trapFocus, FOCUSABLE } = require('../public/js/focus-trap');

// --- minimal DOM double -----------------------------------------------------
function makeEl(name, { focusable = true, hidden = false } = {}) {
  return {
    name, focusable, hidden,
    offsetParent: hidden ? null : {},
    getBoundingClientRect: () => (hidden ? { width: 0, height: 0 } : { width: 10, height: 10 }),
    closest: () => null,
    focus() { global.document.activeElement = this; },
  };
}

function install(inside, { opener = null } = {}) {
  const listeners = [];
  const container = {
    _items: inside,
    querySelectorAll(sel) {
      assert.equal(sel, FOCUSABLE, 'should query the shared focusable selector');
      return inside;
    },
    contains: (el) => inside.includes(el),
  };
  global.document = {
    activeElement: opener,
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    contains: (el) => el === opener || inside.includes(el),
  };
  const release = trapFocus(container);
  const press = (key, shiftKey = false) => {
    let prevented = false;
    const ev = { key, shiftKey, preventDefault: () => { prevented = true; } };
    listeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn(ev));
    return prevented;
  };
  return { release, press, listeners, container };
}

test('Tab off the last element wraps to the first instead of leaving the sheet', () => {
  const [a, b, c] = [makeEl('a'), makeEl('b'), makeEl('c')];
  const { press } = install([a, b, c]);
  global.document.activeElement = c;
  assert.equal(press('Tab'), true, 'the default Tab must be prevented');
  assert.equal(global.document.activeElement, a);
});

test('Shift+Tab off the first element wraps to the last', () => {
  const [a, b, c] = [makeEl('a'), makeEl('b'), makeEl('c')];
  const { press } = install([a, b, c]);
  global.document.activeElement = a;
  assert.equal(press('Tab', true), true);
  assert.equal(global.document.activeElement, c);
});

test('Tab in the middle of the sheet is left to the browser', () => {
  const [a, b, c] = [makeEl('a'), makeEl('b'), makeEl('c')];
  const { press } = install([a, b, c]);
  global.document.activeElement = b;
  assert.equal(press('Tab'), false, 'no preventDefault — natural order still applies');
  assert.equal(global.document.activeElement, b, 'and focus is not moved');
});

test('focus that has escaped the sheet is pulled back to the first element', () => {
  const [a, b] = [makeEl('a'), makeEl('b')];
  const outside = makeEl('behind-the-backdrop');
  const { press } = install([a, b]);
  global.document.activeElement = outside;
  assert.equal(press('Tab'), true);
  assert.equal(global.document.activeElement, a);
});

test('keys other than Tab pass straight through (Escape still closes the sheet)', () => {
  const [a, b] = [makeEl('a'), makeEl('b')];
  const { press } = install([a, b]);
  global.document.activeElement = b;
  assert.equal(press('Escape'), false);
  assert.equal(press('Enter'), false);
  assert.equal(global.document.activeElement, b);
});

test('a sheet with nothing focusable still swallows Tab rather than leaking focus', () => {
  const { press } = install([]);
  assert.equal(press('Tab'), true);
});

test('hidden controls are skipped, so Tab wraps across the visible ones', () => {
  const a = makeEl('a');
  const gone = makeEl('display-none', { hidden: true });
  const c = makeEl('c');
  const { press } = install([a, gone, c]);
  global.document.activeElement = c;
  press('Tab');
  assert.equal(global.document.activeElement, a);
  // …and `gone` is never the wrap target going backwards either.
  global.document.activeElement = a;
  press('Tab', true);
  assert.equal(global.document.activeElement, c);
});

test('release() restores focus to whatever opened the sheet', () => {
  const opener = makeEl('addGameButton');
  const [a] = [makeEl('a')];
  const { release, press } = install([a], { opener });
  global.document.activeElement = a;
  release();
  assert.equal(global.document.activeElement, opener, 'keyboard users return where they were');
  // The listener is gone, so Tab is no longer intercepted after release.
  global.document.activeElement = a;
  assert.equal(press('Tab'), false);
});

test('release() does not throw when the opener has left the document', () => {
  const opener = makeEl('opener');
  const [a] = [makeEl('a')];
  const { release } = install([a], { opener });
  // The view underneath was re-rendered while the sheet was open.
  global.document.contains = () => false;
  global.document.activeElement = a;
  release();
  assert.equal(global.document.activeElement, a, 'focus is left alone rather than thrown at a detached node');
});
