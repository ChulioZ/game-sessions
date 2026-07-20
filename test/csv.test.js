'use strict';

/*
 * RFC 4180 escaping for the operator panel's CSV exports (issue #288).
 *
 * The case that matters is a feedback message containing a comma, a double quote
 * AND a newline at once: an unquoted newline ends the record, so getting this
 * wrong silently shifts every following row into the wrong columns — an export
 * that still opens fine in a spreadsheet and is simply wrong.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CSV_BOM, csvField, toCsv } = require('../lib/csv');

test('csvField quotes every field and doubles inner quotes', () => {
  assert.equal(csvField('plain'), '"plain"');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line1\nline2'), '"line1\nline2"');
  // Absent optional fields (an anonymous submission has no context.email) must
  // become an empty cell, never the string "undefined"/"null".
  assert.equal(csvField(undefined), '""');
  assert.equal(csvField(null), '""');
  assert.equal(csvField(0), '"0"');
});

// Feedback text is written by anyone who can reach the widget and is read by the
// operator in Excel — so a leading formula trigger must be neutralized. Quoting
// alone does not do it: Excel consumes the quotes as CSV syntax and evaluates
// what is left.
test('a leading formula trigger is neutralized, not just quoted', () => {
  assert.equal(csvField('=cmd|\'/c calc\'!A1'), '"\'=cmd|\'/c calc\'!A1"');
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
    assert.equal(csvField(`${lead}payload`), `"'${lead}payload"`, `lead ${JSON.stringify(lead)}`);
  }
  // Only the FIRST character matters — an inner '=' is ordinary text and must
  // not be mangled, or every "a=b" in a message would grow an apostrophe.
  assert.equal(csvField('total=5'), '"total=5"');
  assert.equal(csvField('kein Problem'), '"kein Problem"');
});

test('toCsv writes a header row and CRLF records', () => {
  const csv = toCsv([['A', (r) => r.a], ['B', (r) => r.b]], [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
  assert.equal(csv, '"A","B"\r\n"1","2"\r\n"3","4"\r\n');
});

test('an empty set still emits its header row', () => {
  assert.equal(toCsv([['A', (r) => r.a]], []), '"A"\r\n');
});

// The acceptance criterion from #288, asserted rather than eyeballed.
test('a message with a comma, a quote and a newline does not corrupt later rows', () => {
  const rows = [
    { message: 'Hallo, ich finde die "Würfel"-Ansicht\nkaputt', email: 'a@example.com' },
    { message: 'zweite Nachricht', email: 'b@example.com' },
  ];
  const csv = toCsv([['Nachricht', (r) => r.message], ['E-Mail', (r) => r.email]], rows);

  // Parse it back with a real RFC 4180 reader: quoted newlines stay INSIDE the
  // field, so the document must hold exactly 3 records (header + 2), not 4.
  const records = parseCsv(csv);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], ['Nachricht', 'E-Mail']);
  assert.deepEqual(records[1], ['Hallo, ich finde die "Würfel"-Ansicht\nkaputt', 'a@example.com']);
  // The row AFTER the multi-line message is the one a broken escaper mangles.
  assert.deepEqual(records[2], ['zweite Nachricht', 'b@example.com']);
});

test('the BOM is a single U+FEFF, so Excel reads the file as UTF-8', () => {
  assert.equal(CSV_BOM, '﻿');
  assert.equal(CSV_BOM.length, 1);
  // Round-trips through a UTF-8 buffer as the canonical EF BB BF prefix.
  assert.deepEqual([...Buffer.from(CSV_BOM, 'utf8')], [0xef, 0xbb, 0xbf]);
});

// A minimal RFC 4180 reader — the point is to verify the writer with something
// other than the writer's own logic.
function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { record.push(field); field = ''; } else if (c === '\r' && text[i + 1] === '\n') {
      record.push(field); field = ''; records.push(record); record = []; i += 1;
    } else field += c;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  return records;
}
