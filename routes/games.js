'use strict';

/* Routes for the games of a round: add (with image), retire/restore,
   permanently delete (retired games only).
   Mounted under /api/rounds/:rid/games (mergeParams for rid). */

const express = require('express');
const { z } = require('zod');
const storage = require('../lib/storage');
const { upload, saveUploadedImage } = require('../lib/upload');
const { getProvider, providerCoverUrl } = require('../lib/providers');
const { validateBody } = require('../lib/validate');
const quota = require('../lib/quota');
const { trackEvent } = require('../lib/observability');

const router = express.Router({ mergeParams: true });

// A player count sent as a form field: parseInt (NaN if unparseable), never a
// hard field error — the superRefine below owns the messages so they stay the
// exact strings the route used to emit. `catch(NaN)` keeps NaN flowing through
// (z.number() rejects NaN) instead of raising a generic "expected number" issue.
const playerField = z.preprocess((v) => parseInt(v, 10), z.number().catch(NaN));

// Create-game body. Title and the player range are the only hard requirements.
// Order of the superRefine issues mirrors the old top-to-bottom checks (title,
// then min, max) so the surfaced message is unchanged. The cover/source fields
// are read straight off req.body.
const createGameSchema = z
  .object({
    title: z.preprocess((v) => String(v || '').trim(), z.string()),
    minPlayers: playerField,
    maxPlayers: playerField,
    // Round-tag assignment (#238). Multipart repeats the field, so a single
    // value arrives as a bare string — coerce to a string array either way;
    // membership in the round's tag list is checked in the handler.
    tagIds: z.preprocess(
      (v) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]),
      z.array(z.string())
    ),
  })
  .superRefine((val, ctx) => {
    if (!val.title) ctx.addIssue({ code: 'custom', message: 'Title is missing', path: ['title'] });
    if (!Number.isInteger(val.minPlayers) || val.minPlayers < 1)
      ctx.addIssue({ code: 'custom', message: 'minPlayers is required (integer >= 1)', path: ['minPlayers'] });
    if (!Number.isInteger(val.maxPlayers) || val.maxPlayers < val.minPlayers)
      ctx.addIssue({ code: 'custom', message: 'maxPlayers is required (integer >= minPlayers)', path: ['maxPlayers'] });
  });

// Edit-game body: only the pure, self-contained field checks (present-and-nonempty
// title). The min/max range is reconciled against the *stored* game in the
// handler (it defaults to the game's current values when one side is omitted), so
// it's business logic, not body-shape validation, and stays there.
const updateGameSchema = z.object({
  // `.optional()` short-circuits an absent key before this runs, so (like the old
  // `if (b.title !== undefined) String(b.title).trim()`) it only sees a present
  // value — a blank one 400s with the same message.
  title: z.preprocess((v) => String(v).trim(), z.string().min(1, 'Title is missing')).optional(),
});

// Build the optional { provider, externalId, url } source link from POST fields,
// or null when no known provider is referenced.
function buildSource(body) {
  const provider = getProvider(body.sourceProvider);
  const externalId = String(body.sourceExternalId || '').trim();
  if (!provider || !externalId) return null;
  const url = String(body.sourceUrl || '').trim();
  return {
    provider: provider.id,
    externalId,
    url: /^https?:\/\//.test(url) ? url : null,
  };
}

router.post('/', upload.single('image'), async (req, res) => {
  const round = await req.repo.getRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  // Per-tenant games-per-round cap (#139): only in the public multi-tenant mode.
  // Counts every game in the round (active + retired — both hold a row and a
  // possible cover). multer has buffered any upload in memory but nothing is
  // persisted yet, so refusing here leaves no orphan file.
  if (quota.enforced() && (round.games || []).length >= quota.gamesPerRound()) {
    return res.status(403).json({ error: 'quota_games', limit: quota.gamesPerRound() });
  }

  const body = validateBody(createGameSchema, req, res);
  if (!body) return;
  const { title, minPlayers, maxPlayers } = body;

  // Tags must belong to this round (deduped; unknown ids -> 400, #238).
  const tagIds = [...new Set(body.tagIds)];
  const roundTagIds = new Set((round.tags || []).map((tg) => tg.id));
  if (tagIds.some((x) => !roundTagIds.has(x)))
    return res.status(400).json({ error: 'Unknown tag' });

  // Cover: an uploaded file wins and is stored by us (verified by content —
  // magic bytes — not the client mimetype). A provider image URL is instead
  // stored as-is and hotlinked, never re-hosted (#172).
  let image = null;
  if (req.file) {
    image = await saveUploadedImage(req.file);
    if (!image) return res.status(400).json({ error: 'Uploaded file is not a supported image' });
  } else if (req.body.imageUrl) {
    image = providerCoverUrl(req.body.imageUrl);
  }

  const game = await req.repo.createGame(req.params.rid, {
    title,
    minPlayers,
    maxPlayers,
    image,
    source: buildSource(req.body),
    tagIds,
  });
  if (!game) return res.status(404).json({ error: 'Round not found' });
  trackEvent('game_added', { tenantId: req.tenantId });
  res.status(201).json(game);
});

// Edit game details. Accepts any subset of title, min/max players, the cover
// image, and a provider source link. Sent as JSON, or as
// multipart when an image file is involved (new file, or removeImage=true to
// clear the current one). A cover can also be set from a provider imageUrl and
// the game linked to a provider (sourceProvider/…) — this is what "link an
// existing game to a provider" (issue #74) uses.
router.patch('/:gid', upload.single('image'), async (req, res) => {
  const round = await req.repo.getRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const game = round.games.find((g) => g.id === req.params.gid);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const b = req.body;
  const valid = validateBody(updateGameSchema, req, res);
  if (!valid) return;

  // Collect only the fields that actually change; the data layer applies them.
  const patch = {};

  if (valid.title !== undefined) patch.title = valid.title;
  if (b.minPlayers !== undefined || b.maxPlayers !== undefined) {
    const minPlayers = b.minPlayers !== undefined ? parseInt(b.minPlayers, 10) : game.minPlayers;
    const maxPlayers = b.maxPlayers !== undefined ? parseInt(b.maxPlayers, 10) : game.maxPlayers;
    if (!Number.isInteger(minPlayers) || minPlayers < 1)
      return res.status(400).json({ error: 'minPlayers must be an integer >= 1' });
    if (!Number.isInteger(maxPlayers) || maxPlayers < minPlayers)
      return res.status(400).json({ error: 'maxPlayers must be an integer >= minPlayers' });
    patch.minPlayers = minPlayers;
    patch.maxPlayers = maxPlayers;
  }

  // Replace the game's tag assignment (#238). Sent as JSON, so an array (or
  // null to clear) arrives as-is; unknown ids -> 400 like on create.
  if (b.tagIds !== undefined) {
    const list = Array.isArray(b.tagIds) ? b.tagIds.map(String) : b.tagIds == null ? [] : [String(b.tagIds)];
    const tagIds = [...new Set(list)];
    const roundTagIds = new Set((round.tags || []).map((tg) => tg.id));
    if (tagIds.some((x) => !roundTagIds.has(x)))
      return res.status(400).json({ error: 'Unknown tag' });
    patch.tagIds = tagIds;
  }

  // Attach a provider source link (used to link a previously-unlinked game to a
  // provider). Only set when a valid provider + id is supplied; never clobber an
  // existing link with an empty/invalid one.
  const source = buildSource(b);
  if (source) patch.source = source;

  // Image: a new upload replaces the old file; removeImage clears it; otherwise
  // a provider imageUrl (host-allowlisted) is stored as a hotlink (#172). The
  // old cover is deleted unless another game still references it — and only
  // when we actually hosted it (storage.remove ignores hotlinked URLs).
  const oldImage = game.image;
  let newImage = oldImage;
  if (req.file) {
    const stored = await saveUploadedImage(req.file);
    if (!stored) return res.status(400).json({ error: 'Uploaded file is not a supported image' });
    newImage = stored;
  } else if (b.removeImage === 'true' || b.removeImage === true) {
    newImage = null;
  } else if (b.imageUrl) {
    const linked = providerCoverUrl(b.imageUrl);
    if (linked) newImage = linked; // an untrusted/malformed URL keeps the old cover
  }
  if (newImage !== oldImage) patch.image = newImage;

  // No activity entry: with inline editing, small tweaks are frequent and would
  // just clutter the feed. Retire/restore/add/delete remain the noteworthy events.
  const updated = await req.repo.updateGame(req.params.rid, req.params.gid, patch);
  if (!updated) return res.status(404).json({ error: 'Game not found' });
  if (oldImage && oldImage !== newImage && !(await req.repo.isImageReferenced(oldImage))) {
    await storage.remove(oldImage);
  }
  res.json(updated);
});

// Retire a game (or take it back into the collection). The game is kept, only
// flagged as retired with a timestamp.
router.post('/:gid/retire', async (req, res) => {
  const round = await req.repo.getRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  const retired = req.body.retired !== false; // default: true
  const game = await req.repo.retireGame(req.params.rid, req.params.gid, retired);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(game);
});

// Permanently delete a retired game: remove it from the collection and erase
// every trace of it from past sessions and the activity feed. Rating averages
// are derived from session votes, so they adjust automatically.
router.delete('/:gid', async (req, res) => {
  const round = await req.repo.getRound(req.params.rid);
  if (!round) return res.status(404).json({ error: 'Round not found' });

  // The data layer removes the game and scrubs it from sessions + the feed,
  // returning the deleted game's cover path so the file can be cleaned up.
  const result = await req.repo.deleteGame(req.params.rid, req.params.gid);
  if (result === null) return res.status(404).json({ error: 'Game not found' });
  if (result === 'not_retired')
    return res.status(400).json({ error: 'Only retired games can be deleted' });

  // Remove the cover image unless another game (e.g. in an imported round) still
  // uses the same one. Best effort; the store no longer references it.
  if (result.image && !(await req.repo.isImageReferenced(result.image))) {
    await storage.remove(result.image);
  }

  res.json({ ok: true });
});

module.exports = router;
