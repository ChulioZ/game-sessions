'use strict';

/* Route for a round's design (page background + accent color + texture).
   Mounted under /api/rounds/:rid/background (mergeParams for rid). */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, saveData, findRound } = require('../lib/store');

const router = express.Router({ mergeParams: true });

// Remove an old collage image file when the background changes (legacy data).
function cleanupOldBackground(round, newBg) {
  const old = round.background;
  if (old && old.type === 'collage' && old.image && (!newBg || newBg.image !== old.image)) {
    fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(old.image))).catch(() => {});
  }
}

// Set a design (background + accent), a legacy plain color, or "default".
router.post('/', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  let bg;
  if (req.body.type === 'theme' && typeof req.body.page === 'string' && typeof req.body.accent === 'string') {
    // Page + accent only. (Older data may still carry a "pattern" field from
    // the retired texture system; it is simply ignored by the frontend.)
    bg = { type: 'theme', page: req.body.page, accent: req.body.accent };
  } else if (req.body.type === 'color' && typeof req.body.color === 'string') {
    bg = { type: 'color', color: req.body.color };
  } else {
    bg = { type: 'none' };
  }
  cleanupOldBackground(round, bg);
  round.background = bg;
  saveData();
  res.json({ background: bg });
});

module.exports = router;
