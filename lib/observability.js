'use strict';

/*
 * Observability baseline (issue #132), logging engine now on pino/pino-http
 * (issue #212): structured logging, a request logger, a /healthz handler, and a
 * central error handler with an optional error-tracking hook.
 *
 * Product-usage events (issue #261) ride on the same logger via trackEvent —
 * see the allowlist comment there; no separate analytics service exists.
 *
 * The public exports (logger, requestLogger, healthz, captureError,
 * errorHandler) and the exact log-line shape/fields are unchanged from the
 * previous hand-rolled writer — only the engine underneath is now pino. Kept
 * deliberately minimal:
 *   - the request logger still emits ONLY method/path/status/durationMs/ip (an
 *     allowlist — never bodies, query strings, headers or cookies, which would
 *     carry personal data / secrets), so pino-http's default req/res/err
 *     serializers (which log request headers incl. Authorization/Cookie and the
 *     full URL incl. the query string) are disabled outright and the only fields
 *     logged are the ones customProps builds explicitly.
 *   - the error-tracking provider (Sentry vs self-hosted vs none) is still an
 *     open decision — #212 scoped the logging half only; captureError's
 *     ERROR_WEBHOOK_URL forward stays as the stand-in.
 *
 * LOG_LEVEL (silent | error | warn | info, default info) is read per log call —
 * not bound once at module load — so a deployment or a test can change it and
 * have it take effect (same reason the rate-limit ceilings are read inside
 * createApp(); see .claude/rules/security-middleware.md). Tests set 'silent'.
 */

const pino = require('pino');
const pinoHttp = require('pino-http');

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3 };

// The full request path with the query string stripped. Uses req.originalUrl
// (never rewritten by nested routers, unlike req.path/req.url — which are
// mangled to the mount-relative sub-path by the time the response finishes) so
// the logged path is the real, full one (e.g. /api/rounds, not / or /rounds),
// and drops everything from '?' onward so a query string never leaks into logs.
function reqPath(req) {
  const u = req.originalUrl || req.url || '';
  const q = u.indexOf('?');
  return q === -1 ? u : u.slice(0, q);
}

// Current threshold from LOG_LEVEL (default 'info'; an unknown value falls back
// to 'info' rather than silencing everything by a typo). Every value here is
// also a valid pino level label, so it can be assigned straight to pino's
// `.level` to gate output. Tests set 'silent'.
function currentLevel() {
  const v = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return v in LEVELS ? v : 'info';
}

// Destination that defers to process.stdout.write *at call time*. Two reasons:
// pino otherwise writes straight to fd 1 (bypassing any process.stdout.write
// override a test installs to capture output), and its default SonicBoom sink
// buffers — a plain stream object writes synchronously, so a test can read a
// line immediately after logging it. One JSON line per event, no transport.
const destination = { write: (str) => process.stdout.write(str) };

// pino configured to reproduce the previous writer's exact line shape:
//   { ts: <ISO 8601>, level: <label>, ...fields }
// base:null drops pino's default pid/hostname; the custom timestamp emits `ts`
// as an ISO string (not epoch ms); the level formatter emits the label string
// (not pino's numeric level).
const base = pino({
  base: null,
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  formatters: { level: (label) => ({ level: label }) },
}, destination);

// Read LOG_LEVEL per call by setting pino's threshold immediately before logging
// (pino binds its level once at construction otherwise). Cheap — `.level` is a
// setter over an internal number.
function emit(level, fields) {
  base.level = currentLevel();
  base[level](fields);
}

const logger = {
  info: (fields) => emit('info', fields),
  warn: (fields) => emit('warn', fields),
  error: (fields) => emit('error', fields),
};

// Product-usage events (issue #261): the ONE seam through which a route reports
// "a user did X", so the no-personal-data allowlist below lives in one place
// instead of being re-decided at every call site.
//
// Two hard rules, both enforced here rather than by convention:
//   - the event NAME must be on EVENTS — a typo or an ad-hoc name is dropped
//     (and warned about) instead of silently becoming a new event stream;
//   - the only fields emitted are `event` and `tenantId`. Extra fields passed in
//     are IGNORED, not logged. That is deliberate: it makes "just one more
//     field" impossible to add by accident at a call site, so no game title,
//     member name, e-mail or free text can ever reach the logs (GDPR data
//     minimisation — the same discipline requestLogger's customProps applies).
//     Widening this means editing THIS function and the rule file, on purpose.
//
// Call it AFTER the repo mutation resolves successfully, never before, so a
// failed mutation can't log an event that didn't happen.
// See .claude/rules/product-event-logging.md.
const EVENTS = new Set([
  'round_created',
  'session_created',
  'session_finished',
  'game_added',
  'tag_created',
]);

function trackEvent(name, { tenantId } = {}) {
  if (!EVENTS.has(name)) {
    // Loud but harmless: an unknown name is a bug at the call site, and must
    // not become an untracked event stream.
    logger.warn({ event: 'unknown_product_event', name: String(name) });
    return;
  }
  // Goes through `logger`, so LOG_LEVEL gates it exactly like every other line.
  logger.info({ event: name, tenantId: tenantId || null });
}

// Structured request logging via pino-http, constrained to the same
// no-personal-data allowlist the hand-rolled version enforced: method, route
// path (NO query string, which could carry data), status, duration and client
// IP only — nothing else. pino-http's default serializers (which would log
// headers incl. Authorization/Cookie, the full URL incl. the query string, and
// error stacks) are disabled; the logged object is exactly what customProps
// builds. All requests log at 'info' — like the previous logger.info() call —
// and /healthz is skipped so health probes don't flood the logs.
const httpLogger = pinoHttp({
  logger: base,
  autoLogging: { ignore: (req) => reqPath(req) === '/healthz' },
  serializers: { req: () => undefined, res: () => undefined, err: () => undefined },
  customLogLevel: () => 'info',
  customSuccessMessage: () => undefined,
  customErrorMessage: () => undefined,
  // pino-http names the elapsed time `responseTime`; keep the previous key.
  customAttributeKeys: { responseTime: 'durationMs' },
  customProps: (req, res) => ({
    event: 'request',
    method: req.method,
    path: reqPath(req),
    status: res.statusCode,
    ip: req.ip,
  }),
});

function requestLogger(req, res, next) {
  // Read LOG_LEVEL per request: pino-http logs through `base` on the response's
  // finish event, not via the `logger` wrapper above, so set the threshold here
  // for LOG_LEVEL=silent to still silence request logs.
  base.level = currentLevel();
  return httpLogger(req, res, next);
}

// Liveness/readiness probe. Cheap and side-effect-free so a load balancer or
// uptime monitor can poll it often; mounted before the rate limiter so probes
// are never throttled.
function healthz(req, res) {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}

// The single seam where unexpected errors are recorded. Always logs the error
// structurally (so log aggregation can alert on level=error), and, if
// ERROR_WEBHOOK_URL is configured, forwards a compact, personal-data-free
// notification (method, path, message — no bodies). Never throws: an error on
// the error path must not crash the response.
async function captureError(err, context = {}) {
  logger.error({
    event: 'unhandled_error',
    message: err && err.message,
    stack: err && err.stack,
    ...context,
  });

  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `[Spielwirbel] ${context.method || ''} ${context.path || ''} → ${
          (err && err.message) || 'unknown error'
        }`.trim(),
      }),
    });
  } catch {
    // Swallow: alerting is best-effort and must never mask the original error.
  }
}

// Central Express error handler (must be mounted last, after all routes). Turns
// any unexpected throw / next(err) into a generic 500 with no stack trace leaked
// to the client, after logging + optional alerting. Honours an explicit
// err.status (e.g. a 400 forwarded by upstream middleware) but never exposes
// internals in the body.
function errorHandler(err, req, res, next) {
  // captureError is async but fire-and-forget: the response must not wait on the
  // webhook, and captureError never rejects.
  captureError(err, { method: req.method, path: req.path });
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  res.status(status).json({ error: status === 500 ? 'internal_error' : (err.code || 'error') });
}

module.exports = {
  logger,
  requestLogger,
  healthz,
  captureError,
  errorHandler,
  trackEvent,
  EVENTS,
};
