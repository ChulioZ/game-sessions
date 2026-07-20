'use strict';

/* Route for a round's activity feed: list it, delete a single entry.
   Mounted under /api/rounds/:rid/activities (mergeParams for rid). The feed is
   not part of the round payload (issue #197) — Chronik fetches it here. */

const express = require('express');

const router = express.Router({ mergeParams: true });

router.get('/', async (req, res) => {
  const activities = await req.repo.listActivities(req.params.rid);
  if (!activities) return res.status(404).json({ error: 'Round not found' });
  res.json(activities);
});

router.delete('/:aid', async (req, res) => {
  const round = await req.repo.getRoundMeta(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const deleted = await req.repo.deleteActivity(req.params.rid, req.params.aid);
  if (!deleted) return res.status(404).json({ error: 'Activity not found' });
  res.json({ ok: true });
});

module.exports = router;
