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

/* --------------------------------- lookup ---------------------------------- */

// Resolve a reported '/uploads/<key>' path to the owning game, round and tenant
// — Gap 2 in #268. Read-only: it answers "whose is this?" without changing
// anything, so an operator can assess a notice before acting on it.
router.get('/lookup', async (req, res) => {
  const parsed = imageSchema.safeParse(req.query.image);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const owner = await repo.findImageOwner(parsed.data);
  if (!owner) return res.status(404).json({ error: 'not_found' });

  // Which account(s) hold the owning tenant, so the operator can go straight
  // from an image to the suspendable account.
  const users = (await repo.listUsers())
    .filter((u) => u.tenantId === owner.tenantId)
    .map((u) => ({ id: u.id, email: u.email, disabled: !!u.disabled }));

  res.json({ ...owner, users });
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

// The account list. Strips every secret — hashes, tokens, verification and reset
// material never leave the repo shape, which is why listUsers() returns it raw.
router.get('/users', async (req, res) => {
  const users = (await repo.listUsers()).map((u) => ({
    id: u.id,
    email: u.email,
    tenantId: u.tenantId,
    createdAt: u.createdAt,
    emailVerified: !!u.emailVerified,
    disabled: !!u.disabled,
    disabledAt: u.disabledAt || null,
    disabledReason: u.disabledReason || null,
  }));
  res.json({ users });
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

/* ----------------------------------- log ----------------------------------- */

// The action record backing Art. 17 statements of reasons. Newest first.
router.get('/log', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json({ entries: await repo.listModeration(limit) });
});

module.exports = router;
