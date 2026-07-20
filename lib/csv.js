'use strict';

/*
 * RFC 4180 CSV serialization for the operator panel's exports (issue #288).
 *
 * Deliberately server-side and dependency-free: the only consumer is
 * routes/admin.js, and keeping it out of public/js/** sidesteps the coverage
 * constraint that would otherwise apply (see
 * .claude/rules/frontend-helper-modules-and-coverage.md).
 *
 * The escaping here is the whole point of the module. Feedback messages are
 * user-authored free text that routinely contains commas, double quotes and
 * NEWLINES — an unquoted newline ends the record, so a single multi-line
 * submission would silently shift every following row into the wrong columns.
 * A corrupt export looks plausible in a spreadsheet, which is why this is a pure
 * function with its own unit tests rather than an inline join().
 */

// U+FEFF. Excel assumes the host's legacy 8-bit codepage for a .csv without one
// and renders German umlauts as mojibake ("Grüße" -> "GrÃ¼ÃŸe"); the BOM is what
// makes it read the file as UTF-8. Harmless to every other consumer.
const CSV_BOM = '﻿';

// Every field is quoted unconditionally rather than only when it contains a
// delimiter. RFC 4180 permits it, it costs a few bytes, and it removes the
// entire class of "this value happened to need quoting and didn't get it" bugs.
function csvField(value) {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

// `columns` is [[header, pick(row)], ...]. Records are CRLF-separated per RFC
// 4180 — Excel and LibreOffice both accept LF, but CRLF is what the spec says
// and what older Windows tooling expects.
function toCsv(columns, rows) {
  const lines = [columns.map(([header]) => csvField(header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(([, pick]) => csvField(pick(row))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { CSV_BOM, csvField, toCsv };
