'use strict';

/* Routes for the members of a round: edit name and avatar color.
   Mounted under /api/rounds/:rid/members (mergeParams for rid).
   Adding/removing members after round creation is intentionally out of scope. */

const express = require('express');
const { saveData, findRound } = require('../lib/store');

const router = express.Router({ mergeParams: true });

// Keep in sync with MEMBER_COLORS in public/js/core.js: the curated avatar
// palette. Color is stored only when the user picks one; otherwise it is
// derived from the member's position at read time.
const MEMBER_COLORS = [
  '#d85a30', '#1d9e75', '#7f77dd', '#ba7517',
  '#d4537e', '#2f6f9e', '#639922', '#993556',
];

// Edit a member's name and/or avatar color. Accepts any subset of { name, color }.
router.patch('/:mid', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const member = round.members.find((m) => m.id === req.params.mid);
  if (!member) return res.status(404).json({ error: 'Member not found' });

  const b = req.body;

  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Name is missing' });
    member.name = name;
  }
  if (b.color !== undefined) {
    if (!MEMBER_COLORS.includes(b.color))
      return res.status(400).json({ error: 'Invalid color' });
    member.color = b.color;
  }

  // No activity entry: like the inline game edits, member tweaks are minor and
  // would just clutter the feed.
  saveData();
  res.json(member);
});

module.exports = router;
