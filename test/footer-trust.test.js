'use strict';

/*
 * Footer trust claims (issue #323). The footer makes exactly two public,
 * verifiable statements — EU hosting / GDPR-compliant, and no tracking / ads /
 * third-party scripts. Public commitments drift silently, so they are pinned in
 * BOTH directions per .claude/rules/keep-legal-docs-current.md:
 *
 *  1. Marker tests — the claim strings exist in both language tables, so a
 *     silent reword or removal fails loudly (mirrors the processor markers in
 *     test/legal.test.js).
 *  2. Structural truth-pin — index.html and login.html load no third-party
 *     script, stylesheet or font, so claim 2 cannot quietly become false. The
 *     CSP half of that pin (script/font/connect-src self-only) lives in
 *     test/security.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadLocale(name) {
  const file = path.join(ROOT, 'public', 'js', 'lang', `${name}.js`);
  const context = { I18N: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  return context.I18N[name];
}

// The exact claim strings — kept identical in substance across a reword, which
// is the whole point of pinning them. Change here means change in intent.
const CLAIMS = {
  de: {
    'footer.trustHosting': 'EU-Hosting · DSGVO-konform',
    'footer.trustNoTracking': 'Kein Tracking, keine Werbung, keine Fremd-Skripte',
  },
  en: {
    'footer.trustHosting': 'Hosted in the EU · GDPR-compliant',
    'footer.trustNoTracking': 'No tracking, no ads, no third-party scripts',
  },
};

test('both language tables carry the two trust claims verbatim', () => {
  for (const lang of ['de', 'en']) {
    const dict = loadLocale(lang);
    for (const [key, value] of Object.entries(CLAIMS[lang])) {
      assert.equal(dict[key], value, `${lang}: ${key} must read "${value}"`);
    }
  }
});

test('index.html and login.html load no third-party script, style or font', () => {
  for (const file of ['index.html', 'login.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    for (const m of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
      const tag = m[0];
      const attr = m[1].toLowerCase() === 'script' ? 'src' : 'href';
      const am = tag.match(new RegExp(`${attr}="([^"]*)"`, 'i'));
      if (!am) continue; // inline <script> without a src — first-party, fine
      const url = am[1];
      // Root-absolute AND not protocol-relative: "//cdn.example/x" also starts
      // with "/" but resolves to a third-party origin, so it must be rejected.
      assert.ok(
        url.startsWith('/') && !url.startsWith('//'),
        `${file}: ${m[1]} references "${url}" — must be root-absolute (same-origin)`
      );
    }
  }
});
