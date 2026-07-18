'use strict';

/* Routes for rounds: list, detail, create (optionally importing games), delete. */

const express = require('express');

const router = express.Router();

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
  const name = String(req.body.name || '').trim();
  const members = Array.isArray(req.body.members) ? req.body.members : [];
  const cleanMembers = members.map((m) => String(m || '').trim()).filter(Boolean);

  if (!name) return res.status(400).json({ error: 'Round name is missing' });
  if (cleanMembers.length === 0)
    return res.status(400).json({ error: 'At least one member is required' });

  // The data layer mints ids and (optionally) copies the games list
  // (title/type/image only) from an existing round.
  const round = await req.repo.createRound({
    name,
    members: cleanMembers,
    importFromRoundId: req.body.importFromRoundId || null,
  });
  res.status(201).json(round);
});

router.delete('/:rid', async (req, res) => {
  const deleted = await req.repo.deleteRound(req.params.rid);
  if (!deleted) return res.status(404).json({ error: 'Round not found' });
  res.json({ ok: true });
});

module.exports = router;
