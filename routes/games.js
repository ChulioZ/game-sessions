'use strict';

/* Routes for the games of a round: add (with image), retire/restore,
   permanently delete (retired games only).
   Mounted under /api/rounds/:rid/games (mergeParams for rid). */

const express = require('express');
const { z } = require('zod');
const storage = require('../lib/storage');
const { upload, saveUploadedImage } = require('../lib/upload');
const { getProvider, isAllowedImageUrl } = require('../lib/providers');
const { validateBody } = require('../lib/validate');

const router = express.Router({ mergeParams: true });

const DURATIONS = ['short', 'medium', 'long'];
// Platform is the primary, user-facing field; the analog/digital `type` (which
// still drives Regal filters, badges and buy-next) is derived from it. Only the
// `other` platform lets the client pick the type freely.
const PLATFORMS = ['analog', 'ps', 'xbox', 'switch', 'steam', 'other'];
const PLATFORM_TYPE = { analog: 'analog', ps: 'digital', xbox: 'digital', switch: 'digital', steam: 'digital' };
const IMG_TIMEOUT_MS = 10000;
const MAX_IMG_BYTES = 10 * 1024 * 1024; // mirror the multer upload limit

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// A player count sent as a form field: parseInt (NaN if unparseable), never a
// hard field error — the superRefine below owns the messages so they stay the
// exact strings the route used to emit. `catch(NaN)` keeps NaN flowing through
// (z.number() rejects NaN) instead of raising a generic "expected number" issue.
const playerField = z.preprocess((v) => parseInt(v, 10), z.number().catch(NaN));

// Create-game body. Platform/duration fall back to their defaults on an unknown
// value (never a 400, matching the old `PLATFORMS.includes(...) ? … : 'analog'`);
// title and the player range are the only hard requirements. Order of the
// superRefine issues mirrors the old top-to-bottom checks (title, then min, max)
// so the surfaced message is unchanged. `type` is derived in the handler from
// the validated platform; the cover/source fields are read straight off req.body.
const createGameSchema = z
  .object({
    title: z.preprocess((v) => String(v || '').trim(), z.string()),
    platform: z.enum(PLATFORMS).catch('analog'),
    duration: z.enum(DURATIONS).catch('medium'),
    minPlayers: playerField,
    maxPlayers: playerField,
  })
  .superRefine((val, ctx) => {
    if (!val.title) ctx.addIssue({ code: 'custom', message: 'Title is missing', path: ['title'] });
    if (!Number.isInteger(val.minPlayers) || val.minPlayers < 1)
      ctx.addIssue({ code: 'custom', message: 'minPlayers is required (integer >= 1)', path: ['minPlayers'] });
    if (!Number.isInteger(val.maxPlayers) || val.maxPlayers < val.minPlayers)
      ctx.addIssue({ code: 'custom', message: 'maxPlayers is required (integer >= minPlayers)', path: ['maxPlayers'] });
  });

// Edit-game body: only the pure, self-contained field checks (present-and-nonempty
// title, enum duration). Platform/type and the min/max range are reconciled
// against the *stored* game in the handler (they default to the game's current
// values when one side is omitted), so they're business logic, not body-shape
// validation, and stay there.
const updateGameSchema = z.object({
  // `.optional()` short-circuits an absent key before this runs, so (like the old
  // `if (b.title !== undefined) String(b.title).trim()`) it only sees a present
  // value — a blank one 400s with the same message.
  title: z.preprocess((v) => String(v).trim(), z.string().min(1, 'Title is missing')).optional(),
  duration: z.enum(DURATIONS, { message: 'Invalid duration' }).optional(),
});

// Download a provider cover image into storage and return its /uploads path, or
// null on any failure (never throws — a missing cover must not block adding the
// game). The host is allowlisted by the provider layer (SSRF guard).
async function downloadCover(url) {
  if (!url || !isAllowedImageUrl(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMG_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    const ext = EXT_BY_MIME[mime];
    if (!ext) return null; // not an image type we store
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMG_BYTES) return null;
    return storage.save(buf, ext);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

  const body = validateBody(createGameSchema, req, res);
  if (!body) return;
  const { title, platform, duration, minPlayers, maxPlayers } = body;
  // Platform (default analog) drives the type for the five concrete platforms;
  // only `other` honours the client-supplied analog/digital type.
  const type = platform === 'other'
    ? (req.body.type === 'digital' ? 'digital' : 'analog')
    : PLATFORM_TYPE[platform];

  // Cover: an uploaded file wins; otherwise pull a provider image URL (if given
  // and host-allowlisted) into storage so only the /uploads path is stored. The
  // upload is verified by content (magic bytes), not the client mimetype.
  let image = null;
  if (req.file) {
    image = await saveUploadedImage(req.file);
    if (!image) return res.status(400).json({ error: 'Uploaded file is not a supported image' });
  } else if (req.body.imageUrl) {
    image = await downloadCover(req.body.imageUrl);
  }

  const game = await req.repo.createGame(req.params.rid, {
    title,
    platform,
    type,
    duration,
    minPlayers,
    maxPlayers,
    image,
    source: buildSource(req.body),
  });
  if (!game) return res.status(404).json({ error: 'Round not found' });
  res.status(201).json(game);
});

// Edit game details. Accepts any subset of title, type, duration, min/max
// players, the cover image, and a provider source link. Sent as JSON, or as
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
  // Platform is authoritative: for a concrete platform the type is derived and a
  // client-sent type is ignored; `other` (or a bare type edit, e.g. the Other
  // analog/digital sub-control and the link-provider override) honours the type.
  if (b.platform !== undefined) {
    if (PLATFORMS.includes(b.platform)) {
      patch.platform = b.platform;
      if (b.platform !== 'other') {
        patch.type = PLATFORM_TYPE[b.platform];
      } else if (b.type !== undefined) {
        patch.type = b.type === 'digital' ? 'digital' : 'analog';
      }
    }
    // An invalid platform is ignored (leave platform/type untouched).
  } else if (b.type !== undefined) {
    patch.type = b.type === 'digital' ? 'digital' : 'analog';
  }
  if (valid.duration !== undefined) patch.duration = valid.duration;
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

  // Attach a provider source link (used to link a previously-unlinked game to a
  // provider). Only set when a valid provider + id is supplied; never clobber an
  // existing link with an empty/invalid one.
  const source = buildSource(b);
  if (source) patch.source = source;

  // Image: a new upload replaces the old file; removeImage clears it; otherwise
  // a provider imageUrl (host-allowlisted) is downloaded server-side. The old
  // file is deleted unless another game still references it.
  const oldImage = game.image;
  let newImage = oldImage;
  if (req.file) {
    const stored = await saveUploadedImage(req.file);
    if (!stored) return res.status(400).json({ error: 'Uploaded file is not a supported image' });
    newImage = stored;
  } else if (b.removeImage === 'true' || b.removeImage === true) {
    newImage = null;
  } else if (b.imageUrl) {
    const downloaded = await downloadCover(b.imageUrl);
    if (downloaded) newImage = downloaded; // a failed/blocked download keeps the old cover
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
