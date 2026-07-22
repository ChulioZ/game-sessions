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

test("the column's width depends on the VIEWPORT, never on what a screen renders", () => {
  /* The #332 regression, pinned so it cannot ship twice.

     `.app` is centred, so changing its width moves both its edges — and before
     the rail, navigation was inside it. #332 selected the width by content
     (`.app:has(.cards, …)`), so the tab strip sat at x=480 on Start and x=260
     on Regal, sliding back and forth as the user moved along the tab row.

     A width keyed to the viewport cannot do that: every screen at a given
     viewport gets the same column, so nothing moves as you navigate. A width
     keyed to CONTENT can, and always will. That is the distinction this
     asserts — not "one width", which the rail breakpoint legitimately broke.

     Note the rail's own `.app:has(.rail)` rule is fine and deliberately not
     caught here: it sets `display`/`grid-template-columns`, i.e. it PLACES an
     element. Only rules that choose the column's WIDTH are constrained. */
  const columnRules = RULES.filter(([sel, body]) => {
    if (!/max-width:/.test(body)) return false;
    // A rule targets the column itself when its final compound is the column —
    // `.app > *:not(.rail)` caps CHILDREN and is a different thing entirely.
    return sel.split(',').some((part) => {
      const last = part.trim().split(/[\s>+~]+/).pop() || '';
      return whole('.app').test(last) || whole('.site-footer').test(last);
    });
  });
  assert.ok(columnRules.length, 'no rule sets the content column width at all');

  const contentKeyed = columnRules
    .map(([sel]) => sel)
    .filter((sel) => sel.split(',').some((part) => {
      const last = part.trim().split(/[\s>+~]+/).pop() || '';
      if (!whole('.app').test(last) && !whole('.site-footer').test(last)) return false;
      /* Strip the two column classes and the combinators joining them from the
         WHOLE part; a viewport-keyed rule is built from nothing else. Anything
         left over — `:has(…)`, a state class, an attribute selector — keys off
         content.

         Checking the whole part rather than its last compound is load-bearing:
         `.app:has(.cards) + .site-footer` carries its condition on the FIRST
         compound, and that is the exact shape #332 shipped for the footer. An
         earlier version of this assertion inspected only the last compound and
         let it through. */
      return part
        .replace(/\.app(?![\w-])/g, '')
        .replace(/\.site-footer(?![\w-])/g, '')
        .replace(/[\s>+~]/g, '') !== '';
    }));
  assert.deepEqual(contentKeyed, [],
    'these rules pick the column width from what the screen renders, which moves the navigation');
});

/* The rail hides four things the content column used to carry (the Start tab's
   hero, its CTA, its Tags/Provider/Design links, the Regal's archive footer) and
   the dock itself. Every one of those hides is a plain `display: none` competing
   with a component rule declared ~400 lines further down the stylesheet, so each
   one can lose on specificity or on source order — silently, rendering BOTH the
   rail entry and the thing it replaced. All three shapes below actually happened
   while building this; they cost a browser round trip each and no test noticed. */
test('the rail out-ranks every component it hides', () => {
  // `a.btn` is (0,1,1), so a bare `.rail-owned` (0,1,0) loses to it — and three
  // of the hidden elements are exactly `a.btn`. The qualified form is (0,2,0).
  const railOwned = RULES.filter(([sel]) => whole('.rail-owned').test(sel));
  assert.ok(railOwned.length, 'nothing hides the rail-owned elements');
  railOwned.forEach(([sel, body]) => {
    assert.match(body, /display:\s*none/, `"${sel}" does not hide anything`);
    const classes = (sel.match(/\.[\w-]+/g) || []).length;
    assert.ok(classes >= 2,
      `"${sel}" is one class (0,1,0) and loses to \`a.btn\` (0,1,1), which three of the elements it must hide are`);
  });
});

test('the dock is hidden AFTER it is shown', () => {
  /* `.dock { display: none }` ties `.dock { display: flex }` on specificity, so
     source order decides. Declared in the Layout section — where it reads like
     it belongs, next to the rest of the rail — it lost, and both navs rendered
     at once. RULES is in document order, so the index comparison is the check. */
  const shows = RULES.findIndex(([sel, body]) =>
    /^\.dock$/.test(sel.trim()) && /display:\s*flex/.test(body));
  const hides = RULES.findIndex(([sel, body]) =>
    /^\.dock$/.test(sel.trim()) && /display:\s*none/.test(body));
  assert.ok(shows >= 0, 'no base .dock rule sets display: flex');
  assert.ok(hides >= 0, 'nothing hides the dock at the rail breakpoint');
  assert.ok(hides > shows,
    'the dock is hidden before it is shown, so the later rule wins and BOTH navs render');
});

test('the rail is hidden by default, not only below the breakpoint', () => {
  /* The rail must be `display: none` in the base cascade and switched ON inside
     the min-width block — not the reverse. A rail that defaults to visible and
     is hidden by a max-width query renders on every phone the moment someone
     adds a narrower breakpoint above it. */
  const base = bodyOf('.rail');
  assert.ok(base, 'no base .rail rule');
  assert.match(base, /display:\s*none/,
    '.rail does not default to hidden, so it can leak onto narrow screens');
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

test('the desktop back-button hide is scoped to .back-row, never .section.center', () => {
  /* Seven sub-screens end with a centred "Zurück" that the rail makes
     redundant, so it is hidden from the rail breakpoint up.

     The scoping is the whole risk. The session results screen ends with a
     "Session löschen" block in a BYTE-IDENTICAL `.section.center` wrapper, so a
     hide written against that wrapper would take the delete action with it —
     silently, on one screen, with no error and nothing in the DOM to suggest a
     control is missing. Hence the dedicated `.back-row` class. */
  const hides = RULES.filter(([, body]) => /display:\s*none/.test(body));

  const backHide = hides.filter(([sel]) => whole('.back-row').test(sel));
  assert.ok(backHide.length, 'nothing hides the redundant back row');
  backHide.forEach(([sel]) => {
    const classes = (sel.match(/\.[\w-]+/g) || []).length;
    assert.ok(classes >= 2, `"${sel}" is one class and can lose to a later component rule`);
  });

  const tooBroad = hides
    .map(([sel]) => sel)
    .filter((sel) => /\.section(?![\w-])/.test(sel) && /\.center(?![\w-])/.test(sel)
      && !whole('.back-row').test(sel));
  assert.deepEqual(tooBroad, [],
    'these rules hide every .section.center, which takes "Session löschen" with it');
});

test('short-entry lists tile, and their rows may wrap inside a tile', () => {
  /* The tags and provider screens moved from full-width rows to tiles: as rows
     each carried ~200px of ink across a 900px line, putting a tag's count and
     actions — and a provider's checkbox — some 700px from the label.

     The wrap is the load-bearing half. `.ds-row` is a nowrap flex line sized
     for a 900px width, so inside a ~280px tile the tag rows pushed their
     edit/delete buttons straight out through the right edge, where they were
     CLIPPED AND UNCLICKABLE — visible only as a slightly odd screenshot, with
     every test green. */
  const tiles = bodyOf('.ds-list--tiles');
  assert.ok(tiles, '.ds-list--tiles rule not found');
  assert.match(tiles, /display:\s*grid/, 'the tile list is not a grid');
  const spec = gridSpec(tiles);
  assert.ok(spec.floor && spec.gap, '.ds-list--tiles declares no minmax floor / gap');

  const row = bodyOf('.ds-list--tiles .ds-row');
  assert.ok(row, 'no rule lets a row wrap inside its tile');
  assert.match(row, /flex-wrap:\s*wrap/,
    'rows cannot wrap inside a tile, so a row wider than the tile clips its own controls');

  // `auto-fill` is what makes this need no breakpoint: it must still collapse
  // to a single column on the narrowest phone this app supports.
  assert.match(tiles, /auto-fill/, 'a fixed column count would not collapse on a phone');
  assert.ok(spec.floor <= 320,
    `a ${spec.floor}px floor is wider than a 320px phone's content box, so the grid would overflow`);
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
