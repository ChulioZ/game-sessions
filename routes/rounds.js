'use strict';

/* Routes for rounds: list, detail, create (optionally importing games), delete. */

const express = require('express');
const { data, saveData, id, findRound, pushActivity } = require('../lib/store');

const router = express.Router();

// Compact list for the home screen: identity, live counts, the round's design
// and a "last played" highlight so the lobby cards can tell each round's story.
router.get('/', (req, res) => {
  res.json(
    data.rounds.map((r) => {
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

router.get('/:rid', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  res.json(round);
});

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  const members = Array.isArray(req.body.members) ? req.body.members : [];
  const cleanMembers = members
    .map((m) => String(m || '').trim())
    .filter(Boolean)
    .map((nm) => ({ id: id(), name: nm }));

  if (!name) return res.status(400).json({ error: 'Round name is missing' });
  if (cleanMembers.length === 0)
    return res.status(400).json({ error: 'At least one member is required' });

  const round = {
    id: id(),
    name,
    members: cleanMembers,
    games: [],
    sessions: [],
    activities: [],
    background: null,
  };

  // Optional: copy the games list (title/type/image only) from an existing round.
  const src = req.body.importFromRoundId ? findRound(req.body.importFromRoundId) : null;
  if (src) {
    src.games
      .filter((g) => !g.retired)
      .forEach((g) => {
        const ng = {
          id: id(),
          title: g.title,
          type: g.type,
          image: g.image, // shares the same image file (files are never deleted)
          retired: false,
          retiredAt: null,
        };
        round.games.push(ng);
        pushActivity(round, 'game_added', { gameId: ng.id, title: ng.title });
      });
  }

  data.rounds.push(round);
  saveData();
  res.status(201).json(round);
});

router.delete('/:rid', (req, res) => {
  const idx = data.rounds.findIndex((r) => r.id === req.params.rid);
  if (idx === -1) return res.status(404).json({ error: 'Round not found' });
  data.rounds.splice(idx, 1);
  saveData();
  res.json({ ok: true });
});

module.exports = router;
