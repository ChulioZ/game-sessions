'use strict';

/*
 * Observability baseline (issue #132): /healthz, structured request logging,
 * the central error handler, and the optional error-tracking webhook. The
 * error-handler and captureError paths are exercised on throwaway apps so we can
 * mount a deliberately-throwing route; /healthz and the request logger run
 * against the shared app from helpers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { EventEmitter } = require('node:events');

const { app, createRound } = require('./helpers');
const {
  logger,
  requestLogger,
  captureError,
  errorHandler,
  trackEvent,
  EVENTS,
} = require('../lib/observability');

// Capture everything written to stdout while `fn` runs, restoring afterwards.
async function captureStdout(fn) {
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return orig.call(process.stdout, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines.join('').split('\n').filter(Boolean);
}

// Parse only the JSON log lines, ignoring any unrelated stdout noise the test
// runner may interleave.
//
// The noise is not merely *between* our lines: node:test's reporter writes
// binary IPC frames to the same stdout we're capturing, and one write can carry
// a frame AND a pino line in a single chunk with no newline between them. So
// locate where our JSON actually starts instead of requiring index 0 — a
// `startsWith('{')` check silently drops a real, correctly-emitted log line
// depending on chunk boundaries (which is exactly how it behaves: flaky by
// test-name-pattern and by position in the file).
function parseLogLines(lines) {
  const out = [];
  for (const l of lines) {
    const start = l.indexOf('{"level":');
    if (start === -1) continue;
    try {
      out.push(JSON.parse(l.slice(start)));
    } catch {
      // not one of ours
    }
  }
  return out;
}

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (had) process.env[key] = prev;
      else delete process.env[key];
    }
  })();
}

test('logger writes a structured JSON line with ts + level', async () => {
  const lines = await withEnv('LOG_LEVEL', 'info', () =>
    captureStdout(() => logger.info({ event: 'hello', n: 1 }))
  );
  assert.equal(lines.length, 1);
  const obj = JSON.parse(lines[0]);
  assert.equal(obj.level, 'info');
  assert.equal(obj.event, 'hello');
  assert.equal(obj.n, 1);
  assert.match(obj.ts, /^\d{4}-\d\d-\d\dT/);
});

test('LOG_LEVEL gates output: silent suppresses, error hides info', async () => {
  const silent = await withEnv('LOG_LEVEL', 'silent', () =>
    captureStdout(() => {
      logger.info({ event: 'x' });
      logger.error({ event: 'y' });
    })
  );
  assert.equal(silent.length, 0);

  const errOnly = await withEnv('LOG_LEVEL', 'error', () =>
    captureStdout(() => {
      logger.info({ event: 'info-line' });
      logger.error({ event: 'error-line' });
    })
  );
  assert.equal(errOnly.length, 1);
  assert.equal(JSON.parse(errOnly[0]).event, 'error-line');
});

test('GET /healthz returns 200 with ok status and a numeric uptime', async () => {
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(typeof res.body.uptime, 'number');
  assert.match(res.body.timestamp, /^\d{4}-\d\d-\d\dT/);
});

// Drive requestLogger with a fake req/res so the `finish` event fires
// deterministically (a real supertest request logs in a later tick, after the
// test's env override is already restored — a race, not a real bug).
function fakeReqRes(path, method = 'GET', status = 200) {
  // Carry data that MUST NOT reach the logs: a query string, a body, and
  // secret-bearing headers (Authorization/Cookie). pino-http's default req
  // serializer would log the headers and the full URL incl. the query string,
  // so this fake is what proves those defaults are disabled.
  const req = {
    path,
    method,
    ip: '127.0.0.1',
    // originalUrl is what the logger reads (see reqPath): the full path, never
    // rewritten by routers, with the query string carrying data it must drop.
    originalUrl: `${path}?secret=leak`,
    url: `${path}?secret=leak`,
    query: { secret: 'leak' },
    body: { name: 'Alice' },
    headers: { authorization: 'Bearer SECRET_TOKEN', cookie: 'sa=SECRET_COOKIE' },
  };
  const res = new EventEmitter();
  res.statusCode = status;
  return { req, res };
}

test('request logger logs a request on finish with no personal data', async () => {
  const { req, res } = fakeReqRes('/api/rounds');
  let nexted = false;
  const lines = await withEnv('LOG_LEVEL', 'info', () =>
    captureStdout(() => {
      requestLogger(req, res, () => {
        nexted = true;
      });
      res.emit('finish');
    })
  );
  assert.equal(nexted, true);
  const reqLines = parseLogLines(lines).filter((o) => o.event === 'request');
  assert.equal(reqLines.length, 1);
  assert.equal(reqLines[0].path, '/api/rounds');
  assert.equal(reqLines[0].method, 'GET');
  assert.equal(reqLines[0].status, 200);
  assert.equal(typeof reqLines[0].durationMs, 'number');
  assert.equal(reqLines[0].ip, '127.0.0.1');
  // No body / query (which carry personal data) leak into the log line.
  assert.equal(reqLines[0].body, undefined);
  assert.equal(reqLines[0].query, undefined);
});

test('request log line is a strict allowlist — no headers/query/stack leak', async () => {
  const { req, res } = fakeReqRes('/api/rounds');
  const lines = await withEnv('LOG_LEVEL', 'info', () =>
    captureStdout(() => {
      requestLogger(req, res, () => {});
      res.emit('finish');
    })
  );
  const reqLines = lines.filter((l) => l.startsWith('{'));
  const parsed = parseLogLines(lines).filter((o) => o.event === 'request');
  assert.equal(parsed.length, 1);
  // Exactly these keys — nothing pino-http might add by default (req, res,
  // headers, url, responseTime, msg, reqId, err) may appear.
  assert.deepEqual(
    Object.keys(parsed[0]).sort(),
    ['durationMs', 'event', 'ip', 'level', 'method', 'path', 'status', 'ts']
  );
  // And no secret value survives anywhere in the raw serialized line.
  const raw = reqLines.join('');
  assert.equal(raw.includes('SECRET_TOKEN'), false);
  assert.equal(raw.includes('SECRET_COOKIE'), false);
  assert.equal(raw.includes('secret=leak'), false);
  assert.equal(raw.includes('Alice'), false);
});

test('request logger logs the full path even after a router rewrites req.path', async () => {
  // Nested routers rewrite req.path/req.url to the mount-relative sub-path by
  // the time the response finishes (an /api/rounds request arrives at finish
  // with req.path === '/'). The logger must report the real full path from
  // req.originalUrl, not the mangled one.
  const { req, res } = fakeReqRes('/api/rounds');
  req.path = '/'; // simulate the post-routing mangled value
  req.url = '/';
  const lines = await withEnv('LOG_LEVEL', 'info', () =>
    captureStdout(() => {
      requestLogger(req, res, () => {});
      res.emit('finish');
    })
  );
  const reqLines = parseLogLines(lines).filter((o) => o.event === 'request');
  assert.equal(reqLines.length, 1);
  assert.equal(reqLines[0].path, '/api/rounds');
});

test('request logger is silenced by LOG_LEVEL=silent', async () => {
  const { req, res } = fakeReqRes('/api/rounds');
  const lines = await withEnv('LOG_LEVEL', 'silent', () =>
    captureStdout(() => {
      requestLogger(req, res, () => {});
      res.emit('finish');
    })
  );
  assert.equal(parseLogLines(lines).filter((o) => o.event === 'request').length, 0);
});

test('request logger skips /healthz (no log even on finish)', async () => {
  const { req, res } = fakeReqRes('/healthz');
  const lines = await withEnv('LOG_LEVEL', 'info', () =>
    captureStdout(() => {
      requestLogger(req, res, () => {});
      res.emit('finish');
    })
  );
  const reqLines = parseLogLines(lines).filter((o) => o.event === 'request');
  assert.equal(reqLines.length, 0);
});

// A throwaway app that reproduces createApp's error wiring around a route that
// throws — sync or async — so we can assert the central handler's behaviour.
function throwingApp() {
  const a = express();
  a.get('/boom', () => {
    throw new Error('kaboom: secret internal detail');
  });
  a.get('/boom-async', async () => {
    throw new Error('async kaboom');
  });
  a.use(errorHandler);
  return a;
}

test('error handler turns a sync throw into a generic 500 with no stack leak', async () => {
  await withEnv('LOG_LEVEL', 'silent', async () => {
    const res = await request(throwingApp()).get('/boom');
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'internal_error' });
    // The client must never see the message or a stack trace.
    assert.equal(res.text.includes('kaboom'), false);
    assert.equal(res.text.includes('at '), false);
  });
});

test('error handler also catches async (promise-rejection) throws', async () => {
  await withEnv('LOG_LEVEL', 'silent', async () => {
    const res = await request(throwingApp()).get('/boom-async');
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'internal_error' });
  });
});

test('captureError forwards to ERROR_WEBHOOK_URL when set, with no personal data', async () => {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  };
  try {
    await withEnv('LOG_LEVEL', 'silent', () =>
      withEnv('ERROR_WEBHOOK_URL', 'https://hooks.example/alert', () =>
        captureError(new Error('the failure'), { method: 'POST', path: '/api/rounds' })
      )
    );
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hooks.example/alert');
  const body = JSON.parse(calls[0].opts.body);
  assert.match(body.text, /the failure/);
  assert.match(body.text, /\/api\/rounds/);
});

test('captureError makes no network call when ERROR_WEBHOOK_URL is unset', async () => {
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    return { ok: true };
  };
  try {
    await withEnv('LOG_LEVEL', 'silent', () =>
      withEnv('ERROR_WEBHOOK_URL', undefined, () =>
        captureError(new Error('no webhook'), { method: 'GET', path: '/x' })
      )
    );
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(called, false);
});

test('captureError never throws even if the webhook fetch rejects', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('network down');
  };
  try {
    await withEnv('LOG_LEVEL', 'silent', () =>
      withEnv('ERROR_WEBHOOK_URL', 'https://hooks.example/alert', async () => {
        await captureError(new Error('boom'), { method: 'GET', path: '/x' });
      })
    );
  } finally {
    global.fetch = realFetch;
  }
  // Reaching here without throwing is the assertion.
  assert.ok(true);
});

/* ---------------------------------------------------------------------------
 * Product-usage events (issue #261). Two layers: trackEvent's own allowlist
 * discipline, and the route call sites firing exactly once per real mutation.
 * See .claude/rules/product-event-logging.md.
 * ------------------------------------------------------------------------- */

// Run `fn` with LOG_LEVEL=info and return only the parsed product-event lines
// (dropping the request logger's own `event:'request'` lines and any noise).
async function captureEvents(fn) {
  const lines = await withEnv('LOG_LEVEL', 'info', () => captureStdout(fn));
  return parseLogLines(lines).filter((o) => EVENTS.has(o.event));
}

test('trackEvent logs event + tenantId, and IGNORES any extra field', async () => {
  const events = await captureEvents(() => {
    trackEvent('round_created', {
      tenantId: 't-1',
      // Everything below is exactly what must never reach a log line.
      title: 'Catan',
      memberName: 'Alice',
      email: 'alice@example.com',
      comment: 'free text',
    });
  });

  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.event, 'round_created');
  assert.equal(e.tenantId, 't-1');
  // The allowlist is the whole point: only ts/level/event/tenantId, no more.
  assert.deepEqual(Object.keys(e).sort(), ['event', 'level', 'tenantId', 'ts']);
  const line = JSON.stringify(e);
  for (const leak of ['Catan', 'Alice', 'alice@example.com', 'free text']) {
    assert.ok(!line.includes(leak), `leaked ${leak}`);
  }
});

test('trackEvent drops an unknown event name and warns instead', async () => {
  const lines = await withEnv('LOG_LEVEL', 'info', () =>
    captureStdout(() => trackEvent('made_up_event', { tenantId: 't-1' }))
  );
  const objs = parseLogLines(lines);
  assert.equal(objs.length, 1);
  assert.equal(objs[0].level, 'warn');
  assert.equal(objs[0].event, 'unknown_product_event');
  assert.equal(objs[0].name, 'made_up_event');
});

test('product events honour LOG_LEVEL like every other line', async () => {
  const silent = await withEnv('LOG_LEVEL', 'silent', () =>
    captureStdout(() => trackEvent('game_added', { tenantId: 't-1' }))
  );
  assert.equal(silent.length, 0);
});

test('round_created fires once on a successful create, never on a rejected one', async () => {
  const ok = await captureEvents(async () => {
    const res = await request(app)
      .post('/api/rounds')
      .send({ name: 'Event round', members: ['Alice'] });
    assert.equal(res.status, 201);
  });
  assert.deepEqual(ok.map((e) => e.event), ['round_created']);
  // Accounts are off in the suite, so every caller is the default tenant.
  assert.equal(ok[0].tenantId, 'default');

  // A validation failure must not log an event that didn't happen.
  const rejected = await captureEvents(async () => {
    const res = await request(app).post('/api/rounds').send({ name: '', members: [] });
    assert.equal(res.status, 400);
  });
  assert.deepEqual(rejected, []);
});

test('game_added, session_created and session_finished fire on the real mutations', async () => {
  const round = await createRound(request, { name: 'Flow round' });

  const added = await captureEvents(async () => {
    const res = await request(app)
      .post(`/api/rounds/${round.id}/games`)
      .send({ title: 'Azul', minPlayers: 2, maxPlayers: 4 });
    assert.equal(res.status, 201);
  });
  assert.deepEqual(added.map((e) => e.event), ['game_added']);

  let sid;
  const started = await captureEvents(async () => {
    const res = await request(app).post(`/api/rounds/${round.id}/sessions`).send({ count: 1 });
    assert.equal(res.status, 201);
    sid = res.body.session.id;
  });
  assert.deepEqual(started.map((e) => e.event), ['session_created']);

  const finished = await captureEvents(async () => {
    const res = await request(app)
      .post(`/api/rounds/${round.id}/sessions/${sid}/finish`)
      .send({ winnerIds: [] });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(finished.map((e) => e.event), ['session_finished']);

  // Un-finishing goes through the same route and must NOT count as a finish.
  const unfinished = await captureEvents(async () => {
    const res = await request(app)
      .post(`/api/rounds/${round.id}/sessions/${sid}/finish`)
      .send({ finished: false });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(unfinished, []);
});

test('tag_created fires for a new tag but not for a deduped duplicate', async () => {
  const round = await createRound(request, { name: 'Tag round' });

  const created = await captureEvents(async () => {
    const res = await request(app).post(`/api/rounds/${round.id}/tags`).send({ name: 'Solo' });
    assert.equal(res.status, 201);
  });
  assert.deepEqual(created.map((e) => e.event), ['tag_created']);

  // Same name (different case) reuses the existing tag — still a 201, but it is
  // not a new tag and must not be counted as one.
  const duplicate = await captureEvents(async () => {
    const res = await request(app).post(`/api/rounds/${round.id}/tags`).send({ name: 'solo' });
    assert.equal(res.status, 201);
  });
  assert.deepEqual(duplicate, []);
});
