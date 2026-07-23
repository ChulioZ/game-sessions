'use strict';

/* Routes for rounds: list, detail, create (optionally importing games), delete. */

const express = require('express');
const { z } = require('zod');
const storage = require('../lib/storage');
const { validateBody } = require('../lib/validate');
const quota = require('../lib/quota');
const { trackEvent, logger } = require('../lib/observability');

const router = express.Router();

// Create-round body. `members` is normalized (each entry stringified, trimmed,
// blanks dropped) before the non-empty check, mirroring the old hand-rolled
// clean-then-validate. `importFromRoundId` is passed through untouched.
const createRoundSchema = z.object({
  name: z.preprocess((v) => String(v || '').trim(), z.string().min(1, 'Round name is missing')),
  members: z
    .preprocess(
      (v) => (Array.isArray(v) ? v.map((m) => String(m || '').trim()).filter(Boolean) : []),
      z.array(z.string()).min(1, 'At least one member is required')
    ),
  importFromRoundId: z.unknown().optional(),
});

// Compact list for the home screen: identity, live counts, the round's design
// and a "last played" highlight so the lobby cards can tell each round's story.
// Computed by the data layer (listRoundSummaries) so the Postgres backend can
// answer it in one small statement instead of assembling every game/session of
// the tenant just to count them — the response shape is unchanged.
router.get('/', async (req, res) => {
  res.json(await req.repo.listRoundSummaries());
});

router.get('/:rid', async (req, res) => {
  const round = await req.repo.getRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  res.json(round);
});

router.post('/', async (req, res) => {
  const body = validateBody(createRoundSchema, req, res);
  if (!body) return;

  // Per-tenant round cap (#139): only in the public multi-tenant mode, so
  // today's single-tenant instance is unaffected. A state cap — count the
  // tenant's current rounds; deleting one frees a slot.
  if (quota.enforced()) {
    const limit = quota.roundsPerTenant();
    // Summaries, not full rounds: only the count matters here, and the summary
    // read doesn't drag every game/session row out of the database.
    const rounds = await req.repo.listRoundSummaries();
    if (rounds.length >= limit) {
      return res.status(403).json({ error: 'quota_rounds', limit });
    }
  }

  // The data layer mints ids and (optionally) copies the games list
  // (title/type/image only) from an existing round.
  const round = await req.repo.createRound({
    name: body.name,
    members: body.members,
    importFromRoundId: body.importFromRoundId || null,
  });
  trackEvent('round_created', { tenantId: req.tenantId });
  res.status(201).json(round);
});

router.delete('/:rid', async (req, res) => {
  // A grant lets a grantee act WITHIN a shared round, never destroy the owner's
  // whole round — that stays owner-only (#207). req.grant is set by
  // resolveRoundGrant only when the caller reached this round through a grant
  // rather than owning it; without a grant this is undefined and owners delete
  // normally. (Per-action roles are #137; deleting the round is the one clear
  // owner-only line this slice draws.)
  if (req.grant) return res.status(403).json({ error: 'not_owner' });

  // The data layer hands back the cover paths the round freed — it is the only
  // place that can still see them, since the games cascade away with the round.
  const deleted = await req.repo.deleteRound(req.params.rid);
  if (deleted === null) return res.status(404).json({ error: 'Round not found' });

  // Rows first, bytes second (as in the game delete and the admin erasure): the
  // references are already gone, so a failed object delete leaves an orphaned
  // file, never a broken cover. The round IS deleted at this point, so nothing
  // in here may throw its way into a 500 — the whole loop body is guarded and a
  // failure is logged and stepped over, never surfaced as a failed deletion.
  // The isImageReferenced check matters because createRound's importFromRoundId
  // copies a cover path across rounds rather than the file; storage.remove
  // ignores hotlinked provider URLs by construction (#172).
  for (const image of deleted.images) {
    try {
      if (!(await req.repo.isImageReferenced(image))) await storage.remove(image);
    } catch (err) {
      logger.error({ event: 'round_delete_object_failed', err: err.message });
    }
  }

  res.json({ ok: true });
});

module.exports = router;
