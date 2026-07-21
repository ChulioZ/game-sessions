'use strict';

/*
 * Operator moderation endpoints (issue #268) — the tooling that makes the
 * reactive DSA duties scoped in #140 actually performable: once a valid abuse
 * notice arrives, locate the reported cover image, take it down, suspend the
 * responsible account, and leave a record of why.
 *
 * Mounted at /api/admin in lib/app.js AHEAD of the app's own auth gate (like
 * /api/auth and /api/account), because the operator must be able to reach it
 * whichever mode the instance runs in — and it carries its own, stronger gate:
 * lib/admin.js (ADMIN_PASSWORD, a separate secret from AUTH_PASSWORD; see that
 * file's header for why they must not be the same value).
 *
 * These handlers use the module-level `repo`, NOT req.repo: moderation is
 * deliberately cross-tenant (a notice names an image, not a tenant), which is
 * exactly why the moderation methods are absent from TENANT_METHODS. The tenant
 * middleware never runs for this router. See
 * .claude/rules/admin-moderation-surface.md.
 */

const express = require('express');
const { z } = require('zod');
const { validateBody } = require('../lib/validate');
const admin = require('../lib/admin');
const repo = require('../lib/repo');
const storage = require('../lib/storage');
const quota = require('../lib/quota');
const { instanceStatus } = require('../lib/status');
const { CSV_BOM, toCsv } = require('../lib/csv');
const { logger } = require('../lib/observability');

const router = express.Router();

const REASON_MAX = 500;

// A reason is REQUIRED on every state-changing action: an Art. 17 statement of
// reasons needs one, and it is the whole point of the action log.
const reasonSchema = z.preprocess(
  (v) => String(v || '').trim(),
  z.string().min(1, 'A reason is required').max(REASON_MAX, 'Reason is too long'),
);

// Only ever a stored cover path. Anchoring to '/uploads/' and forbidding
// slashes/dots past it keeps this from being pointed at anything else — the
// stored form is always a single '/uploads/<id><ext>' segment
// (.claude/rules/cover-image-storage-backend.md).
const imageSchema = z.preprocess(
  (v) => String(v || '').trim(),
  z.string().regex(/^\/uploads\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/, 'Not a valid /uploads/ path'),
);

/* ---------------------------------- login ---------------------------------- */

// The only unauthenticated route here. 404s when no ADMIN_PASSWORD is set, so an
// instance that never configured the surface doesn't advertise it at all.
router.post('/login', (req, res) => {
  if (!admin.adminEnabled()) return res.status(404).json({ error: 'admin_disabled' });
  if (!admin.passwordMatches((req.body || {}).password)) {
    logger.warn({ event: 'admin_login_failed', ip: req.ip });
    return res.status(401).json({ error: 'invalid_password' });
  }
  admin.setSession(req, res);
  logger.info({ event: 'admin_login' });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  admin.clearSession(req, res);
  res.json({ ok: true });
});

// Session probe for the UI: 200 when signed in, 401 when not, 404 when the
// surface is off — the same three-way shape the SPA already reads from
// /api/account/me (see .claude/rules/accounts-mode-gate.md).
router.get('/me', admin.requireAdmin, (req, res) => {
  res.json({ ok: true, storage: storage.backend });
});

/* --------------------------- everything below: gated ----------------------- */

router.use(admin.requireAdmin);

/* --------------------------------- status ---------------------------------- */

// How this instance is actually configured (issue #274), so #219's go-live
// checklist is verifiable from the app rather than by eye against Railway's
// env-var list. Read-only, and every field is a derived boolean/enum/number or a
// public host name — never a secret, not even truncated. lib/status.js is where
// that guarantee is kept; don't widen the response here.
router.get('/status', async (req, res) => {
  res.json({ status: await instanceStatus() });
});

/* --------------------------------- lookup ---------------------------------- */

// An opaque entity id as both backends mint them (hex / nanoid-ish). Narrow on
// purpose: these ids are interpolated into repo lookups, and a notice never
// legitimately names anything but one of them.
const idSchema = z.preprocess(
  (v) => String(v || '').trim(),
  z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'Not a valid id'),
);

// Sizing an object costs one stat/HeadObject each, so a tenant sitting at the
// games quota would otherwise fire thousands of requests to answer one panel
// card. Past this many covers the count is still exact and `bytes` becomes a
// documented lower bound (the panel renders it with a "≥").
const SIZE_SAMPLE_MAX = 500;

// Total bytes this tenant occupies in OUR storage. Provider covers are hotlinked
// (#172) and cost us nothing, so isHostedImage filters them out rather than
// counting someone else's CDN as our storage. A size that can't be determined
// (missing object, transport error) is skipped, never guessed.
async function uploadUsage(images) {
  const hosted = (images || []).filter(storage.isHostedImage);
  const sample = hosted.slice(0, SIZE_SAMPLE_MAX);
  const sizes = await Promise.all(sample.map((p) => storage.size(p).catch(() => null)));
  const known = sizes.filter((n) => typeof n === 'number');
  return {
    count: hosted.length,
    sized: known.length,
    bytes: known.reduce((n, b) => n + b, 0),
    complete: known.length === hosted.length,
  };
}

// Everything the operator needs about one tenant once it has been identified,
// whichever way the notice named it. The ceilings ride along so the panel can
// show usage against them (#275 item 5) — it decides what counts as "close to
// the cap"; this reports the numbers, the same division of labour the status
// card uses (.claude/rules/admin-moderation-surface.md).
async function tenantPayload(tenantId) {
  const summary = await repo.tenantSummary(tenantId);
  const users = (await repo.listUsers())
    .filter((u) => (u.tenantId || null) === tenantId)
    .map((u) => ({ id: u.id, email: u.email, disabled: !!u.disabled }));
  return {
    tenantId,
    summary: summary ? { rounds: summary.rounds, totals: summary.totals } : null,
    uploads: await uploadUsage(summary ? summary.images : []),
    quota: {
      enforced: quota.enforced(),
      roundsPerTenant: quota.roundsPerTenant(),
      gamesPerRound: quota.gamesPerRound(),
      tagsPerRound: quota.tagsPerRound(),
    },
    users,
  };
}

// Resolve a notice to a tenant — by cover path (#268), or, since #275, by the
// round link / e-mail address / tenant id a notice or support mail actually
// tends to name. Read-only: it answers "whose is this, and what do they hold?"
// without changing anything, so an operator can assess before acting.
//
// Exactly one selector, deliberately: accepting several and picking a winner
// would make a typo'd second parameter silently change which tenant the
// operator then acts on.
router.get('/lookup', async (req, res) => {
  const given = ['image', 'round', 'tenant', 'email'].filter((k) => req.query[k]);
  if (given.length !== 1) {
    return res.status(400).json({ error: 'Provide exactly one of image, round, tenant, email' });
  }
  const by = given[0];

  const parse = (schema, value) => {
    const out = schema.safeParse(value);
    return out.success ? out.data : null;
  };

  let tenantId = null;
  let owner = null;
  let round = null;

  if (by === 'image') {
    const image = parse(imageSchema, req.query.image);
    if (!image) return res.status(400).json({ error: 'Not a valid /uploads/ path' });
    owner = await repo.findImageOwner(image);
    if (!owner) return res.status(404).json({ error: 'not_found' });
    tenantId = owner.tenantId;
  } else if (by === 'round') {
    const rid = parse(idSchema, req.query.round);
    if (!rid) return res.status(400).json({ error: 'Not a valid id' });
    round = await repo.findRoundOwner(rid);
    if (!round) return res.status(404).json({ error: 'not_found' });
    tenantId = round.tenantId;
  } else if (by === 'email') {
    const user = await repo.getUserByEmail(String(req.query.email || '').trim().toLowerCase());
    if (!user) return res.status(404).json({ error: 'not_found' });
    tenantId = user.tenantId || null;
  } else {
    tenantId = parse(idSchema, req.query.tenant);
    if (!tenantId) return res.status(400).json({ error: 'Not a valid id' });
    // A tenant id is the one selector with nothing to resolve it against, so an
    // unknown one must 404 here rather than render an empty-but-plausible card.
    const summary = await repo.tenantSummary(tenantId);
    if (!summary || !summary.rounds.length) {
      const known = (await repo.listUsers()).some((u) => (u.tenantId || null) === tenantId);
      if (!known) return res.status(404).json({ error: 'not_found' });
    }
  }

  return res.json({ by, owner, round, ...await tenantPayload(tenantId) });
});

/* --------------------------------- content --------------------------------- */

// Every user-authored string in one round — the drill-down that makes a text
// notice actionable, since a report names the offending words, not an id. Kept
// off the tenant summary because it is unbounded (a round may hold 1000 games)
// while the summary must stay small enough to render for a whole tenant.
router.get('/content', async (req, res) => {
  const parsed = idSchema.safeParse(req.query.round);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const content = await repo.roundContent(parsed.data);
  if (!content) return res.status(404).json({ error: 'not_found' });
  res.json({ content });
});

/* --------------------------------- redact ---------------------------------- */

// What a redacted field is replaced with. FIXED, not operator-supplied: a free
// replacement would let the panel write arbitrary text into a user's own data,
// which is a worse power than the one being exercised, and an empty string would
// render as a blank row that reads like a bug rather than a moderation action.
// German like the rest of this surface; the original text is preserved on the
// log entry, which is what an Art. 17 statement of reasons has to point at.
const REDACTED = '[entfernt]';

const REDACT_KINDS = ['round', 'game', 'member', 'tag', 'feedback'];

// Blank one user-authored text field (#275 item 2). Until now only images could
// be taken down, so an illegal round name or game title had no remedy short of
// suspending the whole account or editing the database by hand.
//
// This never deletes a row — a redacted tag keeps its id, so no game silently
// loses a tag as a side effect. Deleting data is erasure (#273) and stays a
// separate, deliberately harder act.
router.post('/redact', async (req, res) => {
  const body = validateBody(z.object({
    kind: z.enum(REDACT_KINDS),
    // Absent for a round (the round IS the target) and required otherwise; the
    // reverse for roundId. Checked below against `kind` rather than with a
    // refinement so each side gets its own message.
    id: idSchema.optional(),
    roundId: idSchema.optional(),
    reason: reasonSchema,
  }), req, res);
  if (!body) return;

  const needsRound = body.kind !== 'feedback';
  if (needsRound && !body.roundId) return res.status(400).json({ error: 'roundId is required' });
  if (body.kind !== 'round' && !body.id) return res.status(400).json({ error: 'id is required' });

  const target = {
    kind: body.kind,
    roundId: needsRound ? body.roundId : null,
    id: body.kind === 'round' ? body.roundId : body.id,
  };

  const done = await repo.redactText(target, REDACTED);
  if (!done) return res.status(404).json({ error: 'not_found' });

  // `previous` is the whole point of the record: once the field is blanked, this
  // entry is the only remaining evidence of what was actually removed — which is
  // exactly what an Art. 17 statement of reasons has to state.
  const entry = await repo.logModeration({
    action: `redact_${body.kind}`,
    target: done.id,
    reason: body.reason,
    at: new Date().toISOString(),
    tenantId: done.tenantId,
    roundId: done.roundId,
    previous: done.previous,
  });

  logger.info({ event: 'admin_redact', tenantId: done.tenantId });
  res.json({ ok: true, redacted: { ...done, replacement: REDACTED }, entry });
});

/* -------------------------------- takedown --------------------------------- */

// Clear the cover from every game referencing it AND delete the stored object,
// then record the action. Order matters: the DB reference is cleared first, so a
// failure to delete the bytes can never leave a row pointing at a missing
// object (the reverse would render a broken cover for the user).
router.post('/takedown', async (req, res) => {
  const body = validateBody(z.object({ image: imageSchema, reason: reasonSchema }), req, res);
  if (!body) return;

  // Capture the owner BEFORE clearing, so the log records what was taken down.
  const owner = await repo.findImageOwner(body.image);
  const cleared = await repo.takedownImage(body.image);
  await storage.remove(body.image);

  const entry = await repo.logModeration({
    action: 'takedown',
    target: body.image,
    reason: body.reason,
    at: new Date().toISOString(),
    tenantId: owner ? owner.tenantId : null,
    roundId: owner ? owner.roundId : null,
    gameId: owner ? owner.gameId : null,
    gameTitle: owner ? owner.gameTitle : null,
    clearedReferences: cleared,
  });

  logger.info({ event: 'admin_takedown', tenantId: owner ? owner.tenantId : null });
  // `cleared: 0` is reported honestly rather than as an error: the object may
  // already have been removed, and deleting the bytes is still worth doing.
  res.json({ ok: true, cleared, entry });
});

/* ---------------------------------- users ---------------------------------- */

// The safe projection of a stored user. listUsers()/getUserById() return the raw
// shape — password hash, refresh tokens, verification and reset material — so
// EVERY response carrying a user goes through here. Never respond with the repo
// shape directly (.claude/rules/admin-moderation-surface.md).
const safeUser = (u) => ({
  id: u.id,
  email: u.email,
  tenantId: u.tenantId,
  createdAt: u.createdAt,
  emailVerified: !!u.emailVerified,
  disabled: !!u.disabled,
  disabledAt: u.disabledAt || null,
  disabledReason: u.disabledReason || null,
});

// The account list.
router.get('/users', async (req, res) => {
  res.json({ users: (await repo.listUsers()).map(safeUser) });
});

// Suspend or restore an account WITHOUT deleting anything, so evidence survives
// a later law-enforcement request. Suspension takes effect immediately: lib/tenant.js
// refuses every /api call for a disabled user, and login/refresh both refuse too,
// so the existing access token can't outlive it (routes/account.js).
router.post('/users/:uid/disabled', async (req, res) => {
  const body = validateBody(z.object({ disabled: z.boolean(), reason: reasonSchema }), req, res);
  if (!body) return;

  const user = await repo.getUserById(req.params.uid);
  if (!user) return res.status(404).json({ error: 'not_found' });

  await repo.updateUser(user.id, {
    disabled: body.disabled,
    disabledAt: body.disabled ? new Date().toISOString() : null,
    disabledReason: body.disabled ? body.reason : null,
    // Drop every refresh token on suspension so the account cannot resume from a
    // stale one if it is later restored.
    refreshTokens: body.disabled ? [] : user.refreshTokens || [],
  });

  const entry = await repo.logModeration({
    action: body.disabled ? 'user_disabled' : 'user_restored',
    target: user.id,
    reason: body.reason,
    at: new Date().toISOString(),
    tenantId: user.tenantId || null,
    email: user.email,
  });

  logger.info({ event: body.disabled ? 'admin_user_disabled' : 'admin_user_restored', tenantId: user.tenantId || null });
  res.json({ ok: true, entry });
});

/* --------------------------- export & erasure (#273) ------------------------ */

// Art. 15/20: everything held for one account, as JSON the operator can hand to
// the data subject.
//
// A POST, not a GET, even though it only reads: a reason is mandatory here like
// on every other logged action, and a reason belongs in the BODY. As a query
// parameter it would be written verbatim into the HTTP access log — which
// records method/path (.claude/rules/product-event-logging.md) — putting the
// text of a subject-access request, quite possibly naming the subject, into a
// second place we would then have to erase.
router.post('/users/:uid/export', async (req, res) => {
  const body = validateBody(z.object({ reason: reasonSchema }), req, res);
  if (!body) return;

  const user = await repo.getUserById(req.params.uid);
  if (!user) return res.status(404).json({ error: 'not_found' });

  const { rounds } = await repo.exportTenant(user.tenantId || null);
  const at = new Date().toISOString();

  // The disclosure itself is logged: handing a copy of someone's data out is an
  // act worth an audit record, and Art. 15 requests are answerable-for.
  const entry = await repo.logModeration({
    action: 'user_exported',
    target: user.id,
    reason: body.reason,
    at,
    tenantId: user.tenantId || null,
    email: user.email,
    rounds: rounds.length,
  });

  logger.info({ event: 'admin_user_exported', tenantId: user.tenantId || null });
  res.json({ export: { exportedAt: at, account: safeUser(user), tenantId: user.tenantId || null, rounds }, entry });
});

// Art. 17: erase the account AND its tenant's round data, then delete the stored
// cover objects. Irreversible, so it is deliberately awkward: a mandatory reason
// plus `confirmEmail`, which must match the account's own address. That makes a
// mis-typed or mis-clicked account id refuse rather than erase the wrong person
// — the one mistake here that cannot be walked back.
//
// Suspension (above) stays the right first response to an abuse case: it
// preserves evidence. Erasure is the opposite and must never be a side effect of
// anything else (#268).
router.post('/users/:uid/erase', async (req, res) => {
  const body = validateBody(
    // min(1) matters: without it an empty confirmEmail would "match" a user row
    // that somehow carries no address, turning the guard off exactly when the
    // data is already odd.
    z.object({ reason: reasonSchema, confirmEmail: z.string().min(1, 'A confirmation e-mail is required') }),
    req, res,
  );
  if (!body) return;

  const user = await repo.getUserById(req.params.uid);
  if (!user) return res.status(404).json({ error: 'not_found' });
  if (body.confirmEmail.trim().toLowerCase() !== String(user.email || '').toLowerCase()) {
    return res.status(400).json({ error: 'confirm_mismatch' });
  }

  const result = await repo.eraseAccount(user.id);
  if (result === 'tenant_shared') return res.status(409).json({ error: 'tenant_shared' });
  if (!result) return res.status(404).json({ error: 'not_found' });

  // Rows first, bytes second (as in /takedown): the references are already gone,
  // so a failed object delete leaves an orphaned file, never a broken cover.
  // One failure must not abort the rest of an erasure that has already happened
  // in the database — count them and report honestly instead.
  let removed = 0;
  let failed = 0;
  for (const image of result.images) {
    try {
      await storage.remove(image);
      removed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ event: 'admin_erase_object_failed', err: err.message });
    }
  }

  // Deliberately NO email and no round/game names on this entry, unlike every
  // other action here: the log outlives the erasure, so copying the erased
  // person's data into it would defeat the erasure it is meant to evidence. The
  // account id, tenant id, date, reason and counts are what proves the request
  // was honoured — which is the record's only job.
  const entry = await repo.logModeration({
    action: 'user_erased',
    target: user.id,
    reason: body.reason,
    at: new Date().toISOString(),
    tenantId: result.tenantId,
    rounds: result.rounds,
    imagesRemoved: removed,
    imagesFailed: failed,
  });

  logger.info({ event: 'admin_user_erased', tenantId: result.tenantId });
  res.json({ ok: true, rounds: result.rounds, imagesRemoved: removed, imagesFailed: failed, entry });
});

/* ------------------------------ paging & export ---------------------------- */

// Both list routes below page with the same (limit, offset) and report a total,
// so the panel can say "100 von 342" instead of silently truncating (#288).
const pageParams = (req) => ({
  limit: Math.min(Math.max(Number(req.query.limit) || 100, 1), 500),
  offset: Math.max(Number(req.query.offset) || 0, 0),
});

// Stream a full export as a CSV attachment. `count` then `list(total)` reads the
// whole set rather than one page — these are operator-sized tables (the panel's
// own inbox and action log), not user data at scale, and the point of the
// download is precisely the entries the card cannot show.
//
// Deliberately NO reason parameter and NO logModeration entry, unlike the write
// actions and the GDPR export above: this discloses nothing the operator cannot
// already read by scrolling the card, to the same operator, and viewing the card
// requires no reason either. See issue #288's Notes.
// Headroom on the read: `count` and `list` are two statements, so an entry
// arriving between them would make `list(total)` return the newest `total` of a
// now-larger set — silently dropping the OLDEST row from the export. Harmless
// when nothing raced (asking for more than exists just returns everything), and
// it keeps a concurrent submission from quietly truncating the action log.
const CSV_HEADROOM = 100;

async function sendCsv(res, { name, columns, count, list }) {
  const total = await count();
  const rows = total ? await list(total + CSV_HEADROOM) : [];
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="spielwirbel-${name}-${date}.csv"`);
  res.send(CSV_BOM + toCsv(columns, rows));
}

/* ----------------------------------- log ----------------------------------- */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

// A bare 'YYYY-MM-DD' (what a date input sends) is widened to cover the whole
// day, and the two ends are widened in OPPOSITE directions: 'to=2026-07-20'
// must include everything that happened ON the 20th, which a naive
// at <= '2026-07-20' would exclude entirely — silently hiding a day's actions
// from the record backing Art. 17. Both backends then compare exact instants,
// so neither can disagree about what the range means.
function bound(value, end) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (DATE_ONLY.test(v)) return `${v}T${end ? '23:59:59.999' : '00:00:00.000'}Z`;
  return ISO_INSTANT.test(v) ? v : undefined; // undefined = malformed
}

// null on every key when nothing was asked for, so the repos take their
// unfiltered path. Returns false for a malformed date so the caller can 400
// rather than quietly return the whole log.
function logFilters(req) {
  const from = bound(req.query.from, false);
  const to = bound(req.query.to, true);
  if (from === undefined || to === undefined) return false;
  return {
    tenantId: String(req.query.tenant || '').trim() || null,
    action: String(req.query.action || '').trim() || null,
    from,
    to,
  };
}

// The action record backing Art. 17 statements of reasons. Newest first, and
// since #275 narrowable to one tenant / action / date range — the log is also
// what gets handed over on a law-enforcement request, where "every action ever"
// is the wrong answer to a question about one account.
router.get('/log', async (req, res) => {
  const { limit, offset } = pageParams(req);
  const filters = logFilters(req);
  if (!filters) return res.status(400).json({ error: 'Not a valid date' });
  res.json({
    entries: await repo.listModeration(limit, offset, filters),
    // Filtered too — a total counting entries the filtered list can never reach
    // would make the card's "20 von 300" a lie about what is being shown.
    total: await repo.countModeration(filters),
  });
});

// The values the filter can actually match, so the panel offers no dead options.
router.get('/log/actions', async (req, res) => {
  res.json({ actions: await repo.moderationActions() });
});

const LOG_COLUMNS = [
  ['Zeitpunkt', (e) => e.at],
  ['Aktion', (e) => e.action],
  ['Ziel', (e) => e.target],
  ['Spiel', (e) => e.gameTitle],
  ['E-Mail', (e) => e.email],
  ['Tenant', (e) => e.tenantId],
  // The redacted original (#275). It exists nowhere else once the field is
  // blanked, so an export that omitted it would not be a complete record.
  ['Vorher', (e) => e.previous],
  ['Begründung', (e) => e.reason],
];

// Honours the same filters as the card, so "export what I'm looking at" does
// exactly that — an export that silently widened back to everything would leak
// unrelated tenants into a hand-over prepared for one.
router.get('/log.csv', async (req, res) => {
  const filters = logFilters(req);
  if (!filters) return res.status(400).json({ error: 'Not a valid date' });
  await sendCsv(res, {
    name: 'protokoll',
    columns: LOG_COLUMNS,
    count: () => repo.countModeration(filters),
    list: (total) => repo.listModeration(total, 0, filters),
  });
});

/* -------------------------------- feedback --------------------------------- */

// In-app user feedback (issue #260), newest first. It lives on THIS router, and
// therefore behind ADMIN_PASSWORD, rather than getting a credential of its own:
// a second admin secret alongside the panel's would be a strictly worse surface
// to secure for no gain. Same limit clamp as /log.
//
// Feedback is global, un-scoped data (like the moderation log), so this reads it
// from the module-level `repo` — req.repo does not exist on this router and
// listFeedback is deliberately absent from TENANT_METHODS.
router.get('/feedback', async (req, res) => {
  const { limit, offset } = pageParams(req);
  res.json({
    entries: await repo.listFeedback(limit, offset),
    total: await repo.countFeedback(),
  });
});

// `context` is flattened into columns rather than dumped as JSON into one cell —
// the whole point of a CSV is that the operator can sort and filter on these.
const FEEDBACK_COLUMNS = [
  ['Zeitpunkt', (f) => f.createdAt],
  ['Nachricht', (f) => f.message],
  ['Pfad', (f) => (f.context || {}).path],
  ['Sprache', (f) => (f.context || {}).locale],
  ['Tenant', (f) => (f.context || {}).tenantId],
  ['E-Mail', (f) => (f.context || {}).email],
];

router.get('/feedback.csv', async (req, res) => {
  await sendCsv(res, {
    name: 'feedback',
    columns: FEEDBACK_COLUMNS,
    count: () => repo.countFeedback(),
    list: (total) => repo.listFeedback(total),
  });
});

module.exports = router;
