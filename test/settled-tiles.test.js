'use strict';

/* Tag and provider tiles (`.ds-list--tiles` of `.ds-row`) must settle into a
   consistent height regardless of label length (#355). Before this, the
   `.ds-row` `space-between` line only wrapped its meta onto a second line for a
   LONG label, so a grid of short and long tags/providers rendered a mix of
   one- and two-line tiles — ragged heights. That is a purely visual regression:
   nothing throws, no other test fails, the controls are even present and
   clickable in the DOM. So pin the two rules that make each list uniform, the
   way `dock-footer-clearance.test.js` pins its silent-visual invariant.

   The tag tile is settled by STACKING (chip line + footer line, always two);
   the provider tile by keeping it to a SINGLE line (name ellipsis-truncates).
   Both are scoped to `.tag-row` / `.provider-row*`, never the shared `.ds-row`
   / `.ds-list--tiles` base — see `.claude/rules/tiles-vs-lists.md`. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Shared parser: strips comments + tokenizes into [selector, body], so a regex
// can't bind inside a comment that merely mentions a class. See
// `.claude/rules/css-text-assertions-strip-comments.md`.
const { bodyOf } = require('./support/css');

test('tag tiles stack into a fixed two-line shape (settled height)', () => {
  const body = bodyOf('.tag-row');
  assert.ok(body, '.tag-row rule not found in styles.css');
  // Column layout is the whole mechanism: it forces the count/actions onto
  // their own line for EVERY tile instead of only the long ones (which wrapped
  // under the base `.ds-row` `space-between`), so all tiles share one height.
  assert.match(body, /flex-direction:\s*column/);
});

test('provider tiles are kept to a single line (settled height)', () => {
  const name = bodyOf('.provider-row__name');
  assert.ok(name, '.provider-row__name rule not found in styles.css');
  // nowrap + overflow + ellipsis: the label never wraps to a second line, so a
  // long provider name can't make its one tile taller than the others.
  assert.match(name, /white-space:\s*nowrap/);
  assert.match(name, /text-overflow:\s*ellipsis/);
  assert.match(name, /overflow:\s*hidden/);

  const row = bodyOf('.provider-row');
  assert.ok(row, '.provider-row rule not found in styles.css');
  // The row itself must not wrap the checkbox onto its own line either.
  assert.match(row, /flex-wrap:\s*nowrap/);
});
