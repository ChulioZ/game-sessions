'use strict';

/* One-time migration tool (#242): move a round's leftover legacy `platform` /
   `duration` game fields onto custom tags. The create/update routes no longer
   write these fields, but games added before #242 may still carry them as
   orphaned jsonb keys — this lists them and lets the user convert each distinct
   value to a tag (existing or freshly created), clearing the legacy field.

   Intentionally a temporary feature: removed once the author has migrated their
   own personal collection (follow-up #243). Mounted under
   /api/rounds/:rid/legacy (mergeParams for rid). */

const express = require('express');
const { z } = require('zod');
const { validateBody } = require('../lib/validate');

const router = express.Router({ mergeParams: true });

// Only these two legacy fields exist; the allowlist also guards the raw jsonb
// key lookup in the repo against arbitrary key injection.
const LEGACY_FIELDS = ['platform', 'duration'];

const migrateSchema = z.object({
  field: z.enum(LEGACY_FIELDS),
  value: z.preprocess((v) => String(v == null ? '' : v), z.string().min(1)),
  tagId: z.preprocess((v) => String(v == null ? '' : v), z.string().min(1)),
});

// List every distinct legacy platform/duration value still present across the
// round's games (active + retired), with how many games carry each.
router.get('/', async (req, res) => {
  const round = await req.repo.getRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  const values = [];
  LEGACY_FIELDS.forEach((field) => {
    const counts = new Map();
    (round.games || []).forEach((g) => {
      const v = g[field];
      if (typeof v === 'string' && v) counts.set(v, (counts.get(v) || 0) + 1);
    });
    [...counts].forEach(([value, count]) => values.push({ field, value, count }));
  });
  res.json({ values });
});

// Apply one value → tag mapping: assign the (existing) round tag to every game
// carrying `value` in `field`, then clear that legacy field on those games.
router.post('/migrate', async (req, res) => {
  const round = await req.repo.getRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  const body = validateBody(migrateSchema, req, res);
  if (!body) return;

  // The tag must already belong to this round (the client creates a new one via
  // the existing POST /tags dedup-or-create path first, then passes its id).
  if (!(round.tags || []).some((tg) => tg.id === body.tagId))
    return res.status(400).json({ error: 'Unknown tag' });

  const migrated = await req.repo.migrateLegacyFieldToTag(
    req.params.rid, body.field, body.value, body.tagId);
  if (migrated === null) return res.status(404).json({ error: 'Round not found' });
  res.json({ migrated });
});

module.exports = router;
