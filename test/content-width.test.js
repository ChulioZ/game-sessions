'use strict';

/* The content column's width, and the grid density inside it (#332).

   #332 set out to fix both ends of the viewport range: a 1920 screen wasted 48%
   of itself on gutter while the Regal stayed at four columns, and the same 220px
   grid floor gave every PHONE a single column (a 22-game shelf measured ~6300px
   of scroll). The phone half shipped and is pinned below.

   The desktop half was reverted, and the invariant that replaced it is the most
   important assertion in this file: **the column has exactly ONE width.**
   `.app` is centred, so varying its width moves both edges — and the hub tab
   strip lives inside it, so a second width made the strip slide 220px sideways
   every time you switched tabs. Width may vary again only once navigation moves
   out of the content column (the desktop rail). Until then a second width is a
   regression, not an improvement, and it must fail loudly rather than ship
   twice.

   The criteria are pinned as ARITHMETIC over the declared numbers — how many
   columns a grid actually gets at a given viewport — rather than as "a rule
   mentioning grid exists". A floor nudged 150px -> 180px keeps every naive
   assertion green while silently returning the phone to one column; the column
   count is what notices. (Verified by making that edit and watching it go red.)

   Parsing traps (stripped comments, whole-class matching) live in
   test/support/css.js — see `.claude/rules/css-text-assertions-strip-comments.md`. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RULES, rulesOf, bodyOf, mediaBlocks, whole, rootPx, gridSpec, columnsIn } =
  require('./support/css');

// The horizontal padding of a `padding: <v> <h> <v>` shorthand.
const sidePadding = (body) => {
  const m = body && body.match(/padding:\s*\d+px\s+(\d+)px/);
  return m ? Number(m[1]) : null;
};

/* Every rule under a query matching `re`, newest first. The stylesheet scopes
   each narrow-screen override next to the component it belongs to, so there are
   several `max-width: 520px` blocks and the two numbers this file needs (`.app`
   padding, the `.cards` floor) live in different ones. Reversed so a lookup
   returns the last-declared rule, i.e. the one the cascade actually applies. */
const rulesUnder = (re) => mediaBlocks()
  .filter(([query]) => re.test(query))
  .flatMap(([, css]) => rulesOf(css))
  .reverse();

const targetsFooter = (sel) => whole('.site-footer').test(sel);
const targetsApp = (sel) => /(^|,)\s*\.app(?![\w-])/.test(sel);

test('the page and its footer take their width from the same variable', () => {
  // A hardcoded px in either drifts from the other the moment the width is
  // re-tuned, and the footer silently stops lining up with the column above it
  // — the same reasoning as the shared --dock-clearance (#324).
  assert.ok(rootPx('--w-content'), ':root does not declare --w-content');
  for (const sel of ['.app', '.site-footer']) {
    const body = bodyOf(sel);
    assert.ok(body, `${sel} rule not found`);
    assert.match(body, /max-width:\s*var\(--w-content\)/,
      `${sel} does not take its max-width from --w-content`);
  }
});

test('the content column has exactly ONE width', () => {
  /* The #332 regression, pinned so it cannot ship twice.

     `.app` is centred, so a second width moves both its edges — and the hub tab
     strip is inside it. Measured at 1920 before the revert: the strip sat at
     x=480 on Start and x=260 on Regal, and because the widths alternated along
     the tab row it slid back and forth as the user moved across it.

     Any rule that gives `.app` (or the footer that mirrors it) a max-width
     other than --w-content reintroduces that, whether it is conditioned on
     `:has()`, a media query or a modifier class. When the desktop rail lands
     and navigation leaves this column, THIS test is the one to revisit — with
     the rail's own left-edge-stability probe replacing it, not with the
     assertion simply deleted. */
  /* Read the declared values and compare them, rather than trying to express
     "any max-width that isn't --w-content" as a negative lookahead: `\s*` can
     backtrack to zero characters, which lets `(?!var\(--w-content\))` pass on
     the very declarations it is meant to exempt. */
  const declaredWidths = (body) =>
    [...body.matchAll(/max-width:\s*([^;]+)/g)].map((m) => m[1].trim());

  const offenders = RULES
    .filter(([sel]) => targetsApp(sel) || targetsFooter(sel))
    .filter(([, body]) => declaredWidths(body).some((v) => v !== 'var(--w-content)'))
    .map(([sel]) => sel);
  assert.deepEqual(offenders, [],
    'these rules give the content column a second width, which moves the hub tab strip');
});

test('a 390 viewport gets two Regal columns, not one', () => {
  const narrow = rulesUnder(/max-width:\s*520px/);
  assert.ok(narrow.length, 'no max-width: 520px block found');

  // Both numbers come from the narrow blocks: they re-pad `.app` as well.
  const pad = sidePadding(bodyOf('.app', narrow));
  assert.ok(pad, '.app is not re-padded for narrow screens');
  const spec = gridSpec(bodyOf('.cards', narrow));
  assert.ok(spec && spec.floor && spec.gap,
    '.cards has no narrow-screen override, so the 220px floor still forces one column');

  const columns = columnsIn(390 - 2 * pad, spec);
  assert.equal(columns, 2,
    `a 390px phone gets ${columns} Regal column(s); the 22-game shelf needs two to halve its scroll`);
});

test('the home lobby tiles once there is room for a second round card', () => {
  /* The lobby is a stack of full-width rows on a phone and a grid above the
     strip breakpoint. A floor set too high leaves it a one-column grid — which
     looks like the change landed while changing nothing at all. */
  const hit = mediaBlocks()
    .map(([query, css]) => ({ query, body: bodyOf('.lobby-list', rulesOf(css)) }))
    .find((b) => b.body && /grid-template-columns/.test(b.body));
  assert.ok(hit, '.lobby-list never becomes a multi-column grid');

  const from = Number(hit.query.match(/min-width:\s*(\d+)px/)[1]);
  const spec = gridSpec(hit.body);
  const base = gridSpec(bodyOf('.lobby-list'));
  // Capped by the column, not by the viewport, once past --w-content.
  const shell = Math.min(from, rootPx('--w-content'));
  const columns = columnsIn(shell - 2 * sidePadding(bodyOf('.app')), {
    floor: spec.floor,
    gap: spec.gap || base.gap,
  });
  assert.ok(columns >= 2,
    `at its own ${from}px breakpoint the lobby still shows ${columns} column(s)`);
});
