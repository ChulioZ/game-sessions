'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { GAME_ICON, gameHue, coverPlaceholder } = require('../public/js/cover');

// Pull the --cover-h value out of the rendered placeholder markup. The value is
// deliberately unitless — see the comment in cover.js / styles.css.
const hueOf = (html) => {
  const m = /--cover-h:(\d+)(\D|$)/.exec(html);
  return m ? Number(m[1]) : null;
};

test('a game with a cover gets no placeholder at all', () => {
  assert.equal(coverPlaceholder({ title: 'Catan', image: '/uploads/a.png' }), '');
});

test('a game without a cover gets the placeholder layer + the game glyph', () => {
  const html = coverPlaceholder({ title: 'Catan' });
  assert.match(html, /class="cover-ph"/);
  assert.match(html, new RegExp(`class="ti ${GAME_ICON}"`));
  // Decorative: the frame's title text is the accessible name, not this glyph.
  assert.match(html, /aria-hidden="true"/);
});

test('the hue is deterministic — same title, same colour every render', () => {
  assert.equal(gameHue('Catan'), gameHue('Catan'));
  assert.equal(hueOf(coverPlaceholder({ title: 'Catan' })), gameHue('Catan'));
});

// Regression guard for a bug that shipped past every other check: with `deg`
// the browser rejects `calc(h + …)` inside oklch(from …) as a type error,
// silently computing the gradient to `none` — flat boxes, no console error.
test('--cover-h is emitted unitless (a deg unit breaks the oklch gradient)', () => {
  const html = coverPlaceholder({ title: 'Catan' });
  assert.match(html, /--cover-h:\d+["\s;]/);
  assert.doesNotMatch(html, /--cover-h:\d+deg/);
});

test('different titles get different hues (the whole point: no wall of identical boxes)', () => {
  const titles = ['Catan', 'Carcassonne', 'Azul', 'Wingspan', 'Dune', 'Root'];
  const hues = titles.map(gameHue);
  // Not a strict guarantee for arbitrary input, but these real-world titles
  // must not collapse onto one colour — that would defeat the feature.
  assert.equal(new Set(hues).size, titles.length);
});

// Regression guard for the hash itself. A weak mix still passes every test
// above (it is deterministic and a handful of titles differ) while collapsing
// real shelves onto a few repeated colours. Spreading into 360 buckets, the
// expected distinct count for N titles is 360*(1-(1-1/360)^N) — ~203 at N=300.
// An implementation that loses bits scores far below that: the first cut of
// gameHue, which used `*` instead of `Math.imul`, managed only 157.
test('hues spread across the full circle, near the theoretical ideal', () => {
  const n = 300;
  const hues = new Set();
  for (let i = 0; i < n; i++) hues.add(gameHue(`Game ${i}`));
  const ideal = 360 * (1 - Math.pow(1 - 1 / 360, n));
  assert.ok(hues.size > ideal * 0.9, `only ${hues.size} distinct hues, expected ~${ideal.toFixed(0)}`);
});

test('the hue is always a usable degree value (0–359), never negative', () => {
  // FNV-1a overflows past 2^31 constantly; a signed `%` would emit negative
  // hues and the gradient would silently fall back to the un-rotated brand.
  const samples = ['', 'a', 'Zzzz', '🎲 Würfel', 'x'.repeat(200), 'Ω≈ç√'];
  samples.forEach((s) => {
    const hue = gameHue(s);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${s} -> ${hue}`);
  });
});

test('a missing/blank title still renders (no crash on half-built game objects)', () => {
  [undefined, null, {}, { title: null }, { title: '' }].forEach((g) => {
    assert.match(coverPlaceholder(g), /class="cover-ph"/);
  });
});
