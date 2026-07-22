'use strict';

/* The floating hub dock is `position: fixed`, and the site footer is a SIBLING
   of `.app` rather than a child — so `.app`'s bottom padding never cleared it
   and the dock covered the legal links + the "Powered by BGG" attribution on
   every hub tab (#324). That regression is invisible from Node: no test fails,
   nothing throws, the markup is present and the links are even clickable in the
   DOM — they are just painted under an opaque fixed element. Since the
   Impressum must be "ständig verfügbar" (§ 5 DDG) and the BGG logo is a licence
   condition, pin the clearance here so removing it fails loudly. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
/* Comments are stripped first, deliberately: they are brace-free text, so a
   selector regex will happily span one and match a `.dock` mentioned in prose
   against an unrelated rule below it. (Verified — an earlier version of this
   file passed against the *broken* stylesheet for exactly that reason.) */
const CSS = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// [selector, body] of every rule in the stylesheet.
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => [m[1].trim(), m[2]]);

const bodyOf = (selector) => {
  const hit = RULES.find(([sel]) => sel === selector);
  return hit ? hit[1] : null;
};

// `.site-footer` as a whole class — never `.site-footer__links`/`__bgg`.
const targetsFooter = (sel) => /\.site-footer(?![\w-])/.test(sel);

test(':root defines the shared dock clearance', () => {
  const root = bodyOf(':root');
  assert.ok(root, ':root rule not found in styles.css');
  assert.match(root, /--dock-clearance:\s*\d+px/);
});

test('every .app rule reserves the dock clearance via the shared variable', () => {
  // `.app` is declared twice — the base rule and the ≤520px override — and BOTH
  // set the bottom padding for the dock. A hardcoded px in either drifts from
  // the footer's copy the moment the dock is resized, which is the exact bug
  // the shared variable exists to prevent (the narrow-screen one shipped that
  // way and was only caught by reading the built CSS).
  const apps = RULES.filter(([sel]) => /(^|,)\s*\.app\s*$/.test(sel));
  assert.ok(apps.length >= 2, `expected the base .app rule and its media override, got ${apps.length}`);
  apps.forEach(([, body]) => {
    assert.match(body, /padding:[^;]*var\(--dock-clearance\)/);
  });
});

test('the site footer gets dock clearance too, from the same variable', () => {
  // Mechanism-tolerant: any rule that conditions the footer on a dock being
  // present. Today that is `.app:has(.dock) + .site-footer`.
  const rule = RULES.find(([sel]) => targetsFooter(sel) && sel.includes('.dock'));
  assert.ok(rule, 'no rule gives .site-footer clearance when a dock is rendered (#324)');
  assert.match(rule[1], /padding-bottom:\s*var\(--dock-clearance\)/);
});

test('the footer clearance is conditional, so dockless screens keep their spacing', () => {
  // The unconditional .site-footer rule must not carry the clearance itself,
  // or every dockless screen grows 120px of dead space below the footer.
  const plain = RULES.filter(([sel]) => targetsFooter(sel) && !sel.includes('.dock'));
  assert.ok(plain.length > 0, '.site-footer rule not found in styles.css');
  plain.forEach(([sel, body]) => {
    assert.doesNotMatch(body, /var\(--dock-clearance\)/,
      `"${sel}" applies the dock clearance unconditionally`);
  });
});
