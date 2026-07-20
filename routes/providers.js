'use strict';

/* Routes for a round's lookup-provider configuration (issue #294): which of the
   registered providers (PS Store, BGG, Steam, Nintendo, Xbox) the add-game and
   link-provider lookups query for this round.
   Mounted under /api/rounds/:rid/providers (mergeParams for rid). */

const express = require('express');
const { z } = require('zod');
const { validateBody } = require('../lib/validate');
const { providers } = require('../lib/providers');

const router = express.Router({ mergeParams: true });

// Ids are validated against the registry, never stored free-form: an unknown id
// would be dead weight the lookup silently ignores, and it is a client bug worth
// surfacing. Duplicates are collapsed so the stored list is a real set.
const providersSchema = z.object({
  providers: z
    .array(z.enum(Object.keys(providers)))
    .max(Object.keys(providers).length * 2)
    .transform((ids) => [...new Set(ids)]),
});

// Replace the round's enabled-provider list. An EMPTY array is valid and
// meaningful ("we type our own titles" — no lookup at all), which is why this is
// a full PUT rather than a toggle endpoint: the two states have to stay
// distinguishable from "never configured" (the key absent = all providers).
router.put('/', async (req, res) => {
  const round = await req.repo.getRoundMeta(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  const body = validateBody(providersSchema, req, res);
  if (!body) return;

  const saved = await req.repo.setProviders(req.params.rid, body.providers);
  if (!saved) return res.status(404).json({ error: 'Round not found' });
  res.json({ providers: saved });
});

module.exports = router;
