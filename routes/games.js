'use strict';

/* Routes for the games of a round: add (with image), retire/restore,
   permanently delete (retired games only).
   Mounted under /api/rounds/:rid/games (mergeParams for rid). */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { data, saveData, id, findRound, pushActivity, UPLOAD_DIR } = require('../lib/store');
const upload = require('../lib/upload');

const router = express.Router({ mergeParams: true });

const DURATIONS = ['short', 'medium', 'long'];

router.post('/', upload.single('image'), (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  const title = String(req.body.title || '').trim();
  const type = req.body.type === 'digital' ? 'digital' : 'analog';
  const duration = DURATIONS.includes(req.body.duration) ? req.body.duration : 'medium';
  if (!title) return res.status(400).json({ error: 'Title is missing' });

  const minPlayers = parseInt(req.body.minPlayers, 10);
  const maxPlayers = parseInt(req.body.maxPlayers, 10);
  if (!Number.isInteger(minPlayers) || minPlayers < 1)
    return res.status(400).json({ error: 'minPlayers is required (integer >= 1)' });
  if (!Number.isInteger(maxPlayers) || maxPlayers < minPlayers)
    return res.status(400).json({ error: 'maxPlayers is required (integer >= minPlayers)' });

  const game = {
    id: id(),
    title,
    type,
    duration,
    minPlayers,
    maxPlayers,
    image: req.file ? '/uploads/' + req.file.filename : null,
    retired: false,
    retiredAt: null,
  };
  round.games.push(game);
  pushActivity(round, 'game_added', { gameId: game.id, title: game.title });
  saveData();
  res.status(201).json(game);
});

// Edit game details. Accepts any subset of title, type, duration, min/max
// players and the cover image. Sent as JSON, or as multipart when an image is
// involved (new file, or removeImage=true to clear the current one).
router.patch('/:gid', upload.single('image'), (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const game = round.games.find((g) => g.id === req.params.gid);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const b = req.body;

  if (b.title !== undefined) {
    const title = String(b.title).trim();
    if (!title) return res.status(400).json({ error: 'Title is missing' });
    game.title = title;
  }
  if (b.type !== undefined) {
    game.type = b.type === 'digital' ? 'digital' : 'analog';
  }
  if (b.duration !== undefined) {
    if (!DURATIONS.includes(b.duration))
      return res.status(400).json({ error: 'Invalid duration' });
    game.duration = b.duration;
  }
  if (b.minPlayers !== undefined || b.maxPlayers !== undefined) {
    const minPlayers = b.minPlayers !== undefined ? parseInt(b.minPlayers, 10) : game.minPlayers;
    const maxPlayers = b.maxPlayers !== undefined ? parseInt(b.maxPlayers, 10) : game.maxPlayers;
    if (!Number.isInteger(minPlayers) || minPlayers < 1)
      return res.status(400).json({ error: 'minPlayers must be an integer >= 1' });
    if (!Number.isInteger(maxPlayers) || maxPlayers < minPlayers)
      return res.status(400).json({ error: 'maxPlayers must be an integer >= minPlayers' });
    game.minPlayers = minPlayers;
    game.maxPlayers = maxPlayers;
  }

  // Image: a new upload replaces the old file; removeImage clears it. The old
  // file is deleted unless another game still references it.
  const oldImage = game.image;
  if (req.file) {
    game.image = '/uploads/' + req.file.filename;
  } else if (b.removeImage === 'true' || b.removeImage === true) {
    game.image = null;
  }
  if (oldImage && oldImage !== game.image) {
    const stillUsed = data.rounds.some((r) => r.games.some((g) => g.image === oldImage));
    if (!stillUsed) fs.unlink(path.join(UPLOAD_DIR, path.basename(oldImage)), () => {});
  }

  // No activity entry: with inline editing, small tweaks are frequent and would
  // just clutter the feed. Retire/restore/add/delete remain the noteworthy events.
  saveData();
  res.json(game);
});

// Retire a game (or take it back into the collection). The game is kept, only
// flagged as retired with a timestamp.
router.post('/:gid/retire', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const game = round.games.find((g) => g.id === req.params.gid);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const retired = req.body.retired !== false; // default: true
  game.retired = retired;
  game.retiredAt = retired ? new Date().toISOString() : null;
  pushActivity(round, retired ? 'game_retired' : 'game_restored', {
    gameId: game.id,
    title: game.title,
  });
  saveData();
  res.json(game);
});

// Permanently delete a retired game: remove it from the collection and erase
// every trace of it from past sessions and the activity feed. Rating averages
// are derived from session votes, so they adjust automatically.
router.delete('/:gid', (req, res) => {
  const round = findRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const idx = round.games.findIndex((g) => g.id === req.params.gid);
  if (idx === -1) return res.status(404).json({ error: 'Game not found' });
  const game = round.games[idx];
  if (!game.retired)
    return res.status(400).json({ error: 'Only retired games can be deleted' });

  round.games.splice(idx, 1);

  // Scrub the game from all sessions of this round.
  round.sessions = round.sessions.filter((s) => {
    s.gameIds = s.gameIds.filter((gid) => gid !== game.id);
    if (s.gameIds.length === 0) return false; // session only contained this game
    for (const mid in s.votes || {}) delete s.votes[mid][game.id];
    if (s.chosenGameId === game.id) {
      s.chosenGameId = null;
      s.chosenAt = null;
      s.finished = false;
      s.finishedAt = null;
      s.winnerIds = [];
    }
    return true;
  });

  // Drop feed entries that reference the game, then log the deletion itself.
  if (Array.isArray(round.activities))
    round.activities = round.activities.filter((a) => a.gameId !== game.id);
  pushActivity(round, 'game_deleted', { title: game.title });

  // Remove the cover image file unless another game (e.g. in an imported
  // round) still uses the same file.
  if (game.image) {
    const stillUsed = data.rounds.some((r) =>
      r.games.some((g) => g.image === game.image)
    );
    if (!stillUsed) {
      const file = path.join(UPLOAD_DIR, path.basename(game.image));
      fs.unlink(file, () => {}); // best effort; data.json no longer references it
    }
  }

  saveData();
  res.json({ ok: true });
});

module.exports = router;
