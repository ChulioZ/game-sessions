'use strict';

/* Routes for rounds: list, detail, create (optionally importing games), delete. */

const express = require('express');
const { z } = require('zod');
const { validateBody } = require('../lib/validate');
const quota = require('../lib/quota');

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
router.get('/', async (req, res) => {
  const rounds = await req.repo.listRounds();
  res.json(
    rounds.map((r) => {
      // Newest finished session whose chosen game still exists (same rule as
      // the round screen's "Zuletzt gespielt" line).
      const lastPlayed = r.sessions
        .filter(
          (s) => s.finished && s.chosenGameId && r.games.some((g) => g.id === s.chosenGameId)
        )
        .sort((a, b) =>
          String(b.finishedAt || b.chosenAt || b.createdAt).localeCompare(
            String(a.finishedAt || a.chosenAt || a.createdAt)
          )
        )[0];
      const lastGame = lastPlayed && r.games.find((g) => g.id === lastPlayed.chosenGameId);
      return {
        id: r.id,
        name: r.name,
        members: r.members.map((m) => ({ id: m.id, name: m.name, color: m.color })),
        memberCount: r.members.length,
        gameCount: r.games.filter((g) => !g.retired).length,
        sessionCount: r.sessions.length,
        playedCount: r.sessions.filter((s) => s.finished).length,
        background: r.background || null,
        lastPlayed: lastPlayed
          ? {
              gameTitle: lastGame.title,
              winnerNames: (lastPlayed.winnerIds || [])
                .map((wid) => (r.members.find((m) => m.id === wid) || {}).name)
                .filter(Boolean),
              at: lastPlayed.finishedAt || lastPlayed.chosenAt || lastPlayed.createdAt,
            }
          : null,
      };
    })
  );
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
    const rounds = await req.repo.listRounds();
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
  res.status(201).json(round);
});

router.delete('/:rid', async (req, res) => {
  const deleted = await req.repo.deleteRound(req.params.rid);
  if (!deleted) return res.status(404).json({ error: 'Round not found' });
  res.json({ ok: true });
});

module.exports = router;
