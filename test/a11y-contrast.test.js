'use strict';

/* Contrast regressions are invisible: nothing throws, nothing renders wrong —
   the numbers just quietly drop below the WCAG AA bar again (#145). These tests
   pin the three colour sources the audit had to fix, so a future palette tweak
   fails here instead of shipping. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

// --- WCAG 2.1 relative luminance + contrast ratio ---------------------------
const srgb = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// Mirrors the CSS hsl() the app emits, so the test measures what ships.
const hsl = (h, s, l) => {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
  );
};

const WHITE = [255, 255, 255];

// Every theme a round can pick, read out of views-round-detail.js so a new theme
// is measured automatically instead of silently escaping these checks.
function themes() {
  const block = /const THEMES = \[([\s\S]*?)\];/.exec(
    fs.readFileSync(path.join(ROOT, 'public/js/views-round-detail.js'), 'utf8')
  );
  assert.ok(block, 'THEMES should be a literal array');
  const found = [...block[1].matchAll(/page:\s*'(#[0-9a-f]{6})',\s*accent:\s*'(#[0-9a-f]{6})'/gi)]
    .map((m) => ({ page: m[1], accent: m[2] }));
  assert.ok(found.length >= 8, 'expected every theme to declare a page and an accent');
  return found;
}
const THEMES = themes();
const PAGES = THEMES.map((th) => th.page);
// The darkest page is the worst case for coloured text drawn straight on it.
const DARKEST = PAGES.map(hex).sort((a, b) => luminance(a) - luminance(b))[0];

const AA_TEXT = 4.5; // normal-size text
const AA_LARGE = 3.0; // >=24px, or >=18.66px bold

// --- the rating scale (avgColor) -------------------------------------------

// Read the lightness straight out of core.js, so the test tracks the shipped
// value rather than a copy that could drift away from it.
function avgColorLightness() {
  const m = /hsl\(\$\{hue\},\s*(\d+)%,\s*(\d+)%\)/.exec(CORE);
  assert.ok(m, 'avgColor should emit an hsl() template with saturation and lightness');
  return { sat: Number(m[1]), light: Number(m[2]) };
}
const avgHue = (avg) => Math.max(0, Math.min(120, ((avg - 1) / 4) * 120));

test('every rating on the 1–5 scale clears AA as a fill under white text', () => {
  const { sat, light } = avgColorLightness();
  const failures = [];
  for (let avg = 1; avg <= 5.0001; avg += 0.1) {
    const rgb = hsl(avgHue(avg), sat, light);
    const ratio = contrast(rgb, WHITE);
    if (ratio < AA_TEXT) failures.push(`Ø${avg.toFixed(1)} = ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, [], `.score-pill is 14px white text on avgColor(); needs ${AA_TEXT}:1`);
});

test('every rating clears AA-large as ring text on each theme page', () => {
  const { sat, light } = avgColorLightness();
  const failures = [];
  for (const page of PAGES) {
    for (let avg = 1; avg <= 5.0001; avg += 0.1) {
      const ratio = contrast(hsl(avgHue(avg), sat, light), hex(page));
      // .gd-ring__num is 24px/700 -> large text; the ring stroke is a graphical
      // object. Both sit at the 3:1 bar.
      if (ratio < AA_LARGE) failures.push(`${page} Ø${avg.toFixed(1)} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, [], `.gd-ring__num draws avgColor() on the page; needs ${AA_LARGE}:1`);
});

// --- member avatar palette --------------------------------------------------

function memberColors() {
  const block = /const MEMBER_COLORS = \[([\s\S]*?)\];/.exec(CORE);
  assert.ok(block, 'MEMBER_COLORS should be a literal array in core.js');
  const found = block[1].match(/#[0-9a-f]{6}/gi) || [];
  assert.equal(found.length, 8, 'the palette should still hold 8 colors');
  return found;
}

test('every member color carries white initials at AA', () => {
  const failures = memberColors()
    .map((c) => ({ c, ratio: contrast(hex(c), WHITE) }))
    .filter(({ ratio }) => ratio < AA_TEXT)
    .map(({ c, ratio }) => `${c} = ${ratio.toFixed(2)}:1`);
  assert.deepEqual(failures, [], '.avatar / .nr-seat__avatar render white initials on these');
});

// --- semantic colours used as text -----------------------------------------

test('every theme accent clears AA as text on its own page and on white', () => {
  // The accent becomes --brand, which is not only a fill: `.link-btn` paints the
  // breadcrumbs and inline actions with it straight on the page, and the theme
  // card prints each theme's name in its own accent. Sand and Pfirsich shipped
  // at 3.8:1, so choosing either put every link in the app below AA (#145).
  const failures = [];
  for (const { page, accent } of THEMES) {
    const onPage = contrast(hex(accent), hex(page));
    const onWhite = contrast(hex(accent), WHITE);
    if (onPage < AA_TEXT) failures.push(`${accent} on its page ${page} = ${onPage.toFixed(2)}:1`);
    if (onWhite < AA_TEXT) failures.push(`${accent} on --surface = ${onWhite.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, [], 'the accent is used as link text on both surfaces');
});

test('the semantic colours clear AA as text on white AND on the darkest theme page', () => {
  const failures = [];
  for (const name of ['--good', '--warn', '--danger', '--ink-soft']) {
    const m = new RegExp(`\\${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(CSS);
    assert.ok(m, `${name} should be a plain hex in :root`);
    // Measured on BOTH backgrounds these colours actually land on: cards are
    // white --surface, but a bare .link-btn sits straight on the page. Checking
    // white alone hid three sub-AA values (#145).
    for (const [where, bg] of [['white', WHITE], ['darkest page', DARKEST]]) {
      const ratio = contrast(hex(m[1]), bg);
      if (ratio < AA_TEXT) failures.push(`${name} ${m[1]} on ${where} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, [], 'used as text on --surface and directly on --page-bg');
});
