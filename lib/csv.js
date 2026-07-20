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

// Spreadsheet formula injection. A cell whose text begins with one of these is
// evaluated as a FORMULA by Excel and LibreOffice, not shown as text — so a
// feedback message of `=cmd|'/c calc'!A1` becomes code the operator's machine
// runs on open. RFC 4180 quoting does NOT prevent this: the quotes are consumed
// as CSV syntax and the formula is what remains.
//
// That matters more here than in most exports: the text is written by anyone who
// can reach the feedback widget, the reader is the operator (the most privileged
// human on the instance), and this file exists specifically to be opened in
// Excel — that is the whole reason for the BOM above.
//
// The fix is OWASP's: prefix a leading trigger with a single quote, which Excel
// consumes as "treat the rest as literal text" and does not display. TAB and CR
// are included because both can lead a cell the same way.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

// Every field is quoted unconditionally rather than only when it contains a
// delimiter. RFC 4180 permits it, it costs a few bytes, and it removes the
// entire class of "this value happened to need quoting and didn't get it" bugs.
function csvField(value) {
  if (value === null || value === undefined) return '""';
  const text = String(value);
  // The trade-off, accepted deliberately: a legitimate message that opens with
  // "-" or "=" gains a leading apostrophe in the file. Excel hides it; a plain
  // text reader shows it. Mangling a leading dash beats executing a formula.
  const safe = FORMULA_LEAD.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
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
