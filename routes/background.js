'use strict';

/* Route for a round's design (page background + accent color + texture).
   Mounted under /api/rounds/:rid/background (mergeParams for rid). */

const express = require('express');
const storage = require('../lib/storage');

const router = express.Router({ mergeParams: true });

// Remove an old collage image when the background changes (legacy data).
async function cleanupOldBackground(old, newBg) {
  if (old && old.type === 'collage' && old.image && (!newBg || newBg.image !== old.image)) {
    await storage.remove(old.image);
  }
}

// Set a design (background + accent), a legacy plain color, or "default".
router.post('/', async (req, res) => {
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

  const result = await req.repo.setBackground(req.params.rid, bg);
  if (!result) return res.status(404).json({ error: 'Round not found' });
  await cleanupOldBackground(result.previous, bg);
  res.json({ background: bg });
});

module.exports = router;
