# Cover-image storage is a read-through proxy, not public bucket URLs

Issue #128 added a second cover-image storage backend behind `S3_BUCKET`
(`lib/storage/index.js` picks `s3.js` when it's set, else `disk.js`), mirroring
the `lib/repo/` seam. Routes and `lib/upload.js` go through `lib/storage` —
`save(buffer, ext) -> '/uploads/<key>'`, `remove(publicPath)`, and an Express
`serve` handler mounted at `/uploads` in `lib/app.js`. Both backends satisfy the
same contract, so nothing else changes when the backend does.

> **Scope note (#172, 2026-07-20):** everything below is about images **we
> host** — i.e. members' own uploads. Since #172 a **provider** cover is no
> longer downloaded at all: it is hotlinked, and `game.image` then holds the
> provider's own `https://…` URL. So `image` has **two** shapes now, and the
> "always same-origin" claim below holds only for the uploads. See
> `.claude/rules/provider-cover-hotlinking.md` — in particular for why
> `storage.remove()` must ignore anything that isn't a `/uploads/` path.

**The non-obvious decision — keep it:** the stored `image` value for an
**uploaded** cover stays a **same-origin `/uploads/<key>` path for both
backends**, and the S3 backend
**streams objects back through the app** (`GET /uploads/<key>` → `GetObjectCommand`
→ pipe). Do **not** "simplify" this to storing a public bucket/CDN URL in `image`
and pointing the frontend at it directly. That path looks cheaper but breaks
three invariants at once:

- **Auth gate.** `/uploads` is mounted behind `auth.requireAuth` because cover
  images are user data. A public bucket URL bypasses that gate entirely.
- **CSP.** The frontend renders covers as `background-image:url('<image>')`,
  governed by CSP `img-src 'self'` (`lib/app.js`). A cross-origin bucket URL would
  need `img-src` widened to that host; a same-origin `/uploads/…` path needs no
  CSP change (see `.claude/rules/security-middleware.md`).
- **Data compatibility.** Existing `data.json` rows already hold `/uploads/<key>`
  paths, and `isImageReferenced` compares that exact string. Changing the stored
  shape would need a data migration for no real benefit.

Other gotchas baked in:

- **The public path never carries the S3 key prefix.** `S3_PREFIX` namespaces the
  object key inside the bucket; the app rebuilds the key as
  `prefix + path.basename(reqPath)` on serve/remove. So `save` returns
  `/uploads/<name>` (no prefix) and the prefix is an internal detail only.
- **`basename` is the traversal guard.** `serve`/`remove` take
  `path.basename(...)` of the request/stored path, so a key is always a single
  `<id><ext>` segment — it can't escape the prefix. Keep that.
- **`save`/`remove`/`saveUploadedImage` are async now.** `saveUploadedImage`
  (`lib/upload.js`) returns a Promise; its two callers in `routes/games.js` must
  `await` it. A rejected `save` on a *user upload* surfaces as a 500 (Express 5
  forwards it) — same as a disk write failing; a rejected `save` inside
  `downloadCover` (a *provider* cover) is swallowed to null so it never blocks
  adding the game.
- **Testing needs no network or bucket.** `lib/storage/s3.js` is a factory
  (`createS3Storage({ client, bucket, prefix })`); tests inject a fake client whose
  `send(cmd)` branches on `cmd.constructor.name` (`Put/Get/DeleteObjectCommand`).
  See `test/storage.test.js` — the same "stub the boundary" idea the provider
  tests use for `fetch`. The default backend is disk, so `S3_BUCKET` is unset in
  CI and the `@aws-sdk/client-s3` dependency is only loaded when S3 is configured.

**Why:** the roadmap (§3) moves uploads off local disk so the app tier is
stateless for a hosted/scaled deployment. The read-through proxy achieves that
while leaving the auth gate, CSP, frontend, and stored data shape untouched — the
whole app behaves identically, only the bytes move.
