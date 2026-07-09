'use strict';

/*
 * The two language files must stay in key parity (see CLAUDE.md). They are
 * plain browser scripts that register into a global I18N, so we load them in a
 * tiny vm sandbox that provides that global, then diff the key sets.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadLocale(name) {
  const file = path.join(__dirname, '..', 'public', 'js', 'lang', `${name}.js`);
  const context = { I18N: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  return context.I18N[name];
}

test('en.js and de.js expose the exact same set of keys', () => {
  const en = Object.keys(loadLocale('en')).sort();
  const de = Object.keys(loadLocale('de')).sort();

  const missingInDe = en.filter((k) => !de.includes(k));
  const missingInEn = de.filter((k) => !en.includes(k));

  assert.deepEqual(missingInDe, [], `keys present in en but missing in de: ${missingInDe.join(', ')}`);
  assert.deepEqual(missingInEn, [], `keys present in de but missing in en: ${missingInEn.join(', ')}`);
});

test('no translation value is left empty', () => {
  for (const name of ['en', 'de']) {
    const dict = loadLocale(name);
    for (const [key, value] of Object.entries(dict)) {
      assert.ok(String(value).trim().length > 0, `${name}: empty value for ${key}`);
    }
  }
});
