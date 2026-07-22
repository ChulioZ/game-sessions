'use strict';

/* Unit tests for public/js/session-path.js — the URL mapping for the transient
   session-flow screens (#329). These paths are what makes browser/OS Back step
   through the hot-seat wizard instead of ejecting the user, so the round-trip
   and the "don't resolve to step 0" guards are worth pinning down. */

const test = require('node:test');
const assert = require('node:assert');

const {
  sessionSetupPath,
  sessionStepPath,
  sessionFinalePath,
  parseSessionPath,
} = require('../public/js/session-path');

test('builds the three flow paths', () => {
  assert.equal(sessionSetupPath('r1'), '/round/r1/session/new');
  assert.equal(sessionStepPath('r1', 's9', 0), '/round/r1/session/s9/vote/1');
  assert.equal(sessionFinalePath('r1', 's9'), '/round/r1/session/s9/finale');
});

test('steps are 1-based in the URL and round-trip back to the 0-based index', () => {
  for (const step of [0, 1, 7, 42]) {
    const parsed = parseSessionPath(sessionStepPath('r1', 's9', step));
    assert.deepEqual(parsed, { kind: 'vote', rid: 'r1', sid: 's9', step });
  }
  // The first screen reads as /vote/1, never /vote/0.
  assert.ok(sessionStepPath('r1', 's9', 0).endsWith('/vote/1'));
});

test('parses the setup and finale paths', () => {
  assert.deepEqual(parseSessionPath('/round/r1/session/new'), {
    kind: 'setup', rid: 'r1', sid: null, step: null,
  });
  assert.deepEqual(parseSessionPath('/round/r1/session/s9/finale'), {
    kind: 'finale', rid: 'r1', sid: 's9', step: null,
  });
});

test('a trailing slash is tolerated', () => {
  assert.equal(parseSessionPath('/round/r1/session/new/').kind, 'setup');
  assert.equal(parseSessionPath('/round/r1/session/s9/vote/3/').step, 2);
});

test('the results path is NOT a flow path', () => {
  // /round/:rid/session/:sid is a genuinely routable view (showResultsById);
  // swallowing it here would send every shared result link to the round hub.
  assert.equal(parseSessionPath('/round/r1/session/s9'), null);
});

test('non-flow paths are null', () => {
  for (const p of [
    '/',
    '/round/r1',
    '/round/r1/regal',
    '/round/r1/game/g1',
    '/round/new',
    '/round/r1/sessions/s9/vote/1',
    '',
    null,
    undefined,
  ]) {
    assert.equal(parseSessionPath(p), null, `expected null for ${JSON.stringify(p)}`);
  }
});

test('a malformed step is null, never step 0', () => {
  // A bad step must not silently drop the user at the start of a wizard whose
  // votes live only in memory — the router then sends them to the hub instead.
  for (const bad of ['0', '-1', 'x', '1.5', '01', '', ' 2']) {
    assert.equal(
      parseSessionPath(`/round/r1/session/s9/vote/${bad}`),
      null,
      `expected null for step ${JSON.stringify(bad)}`
    );
  }
  assert.equal(parseSessionPath('/round/r1/session/s9/vote'), null);
});

test('extra trailing segments are rejected', () => {
  assert.equal(parseSessionPath('/round/r1/session/new/extra'), null);
  assert.equal(parseSessionPath('/round/r1/session/s9/finale/extra'), null);
  assert.equal(parseSessionPath('/round/r1/session/s9/vote/1/extra'), null);
});
