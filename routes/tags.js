'use strict';

/* Routes for a round's custom tags (issue #238): create (deduped by name) and
   delete (unassigns the tag from every game). Games are (un)tagged via the
   existing games routes' `tagIds` field, not here.
   Mounted under /api/rounds/:rid/tags (mergeParams for rid). */

const express = require('express');
const { z } = require('zod');
const { validateBody } = require('../lib/validate');
const quota = require('../lib/quota');

const router = express.Router({ mergeParams: true });

const createTagSchema = z.object({
  name: z.preprocess((v) => String(v || '').trim(), z.string().min(1, 'Tag name is missing')),
});

// Create a tag. A name matching an existing tag (trimmed, case-insensitive)
// returns that tag instead of creating a duplicate.
router.post('/', async (req, res) => {
  const round = await req.repo.getRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  const body = validateBody(createTagSchema, req, res);
  if (!body) return;

  // Per-tenant tags-per-round cap (#139/#238): only in the public multi-tenant
  // mode, and only for a genuinely NEW name — a duplicate reuses the existing
  // tag and must keep working at the cap.
  const exists = (round.tags || []).some((tg) => tg.name.toLowerCase() === body.name.toLowerCase());
  if (!exists && quota.enforced() && (round.tags || []).length >= quota.tagsPerRound()) {
    return res.status(403).json({ error: 'quota_tags', limit: quota.tagsPerRound() });
  }

  const tag = await req.repo.addTag(req.params.rid, body.name);
  if (!tag) return res.status(404).json({ error: 'Round not found' });
  res.status(201).json(tag);
});

// Delete a tag; the data layer also unassigns it from every game that had it.
router.delete('/:tagId', async (req, res) => {
  const round = await req.repo.getRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const deleted = await req.repo.deleteTag(req.params.rid, req.params.tagId);
  if (!deleted) return res.status(404).json({ error: 'Tag not found' });
  res.json({ ok: true });
});

module.exports = router;
