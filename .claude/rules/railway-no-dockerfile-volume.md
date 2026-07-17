# Railway's builder rejects the Dockerfile `VOLUME` instruction

The production deploy (Railway, issue #131 — see `docs/deploy-railway.md`) builds
the repo `Dockerfile`. Railway's **Metal builder refuses any `VOLUME` line**:

```
dockerfile invalid: docker VOLUME at Line 44 is not supported, use Railway Volumes
```

It's a **build-parse rejection**, so the whole deploy fails before the image is
even built — and it's easy to misdiagnose, because our own `Docker` CI job (plain
BuildKit) builds the identical Dockerfile fine. GitHub only shows a Railway-posted
commit status ("Deployment failed"); the real reason is in the Railway Build Logs.

**Rule:** the `Dockerfile` must **not** declare `VOLUME /data` (or any `VOLUME`).
The instruction was only a hint (auto-create an anonymous volume when none is
mounted) and the app never needs it — it writes to `DATA_DIR=/data` regardless of
what's mounted there. Persistence is attached **at the platform level**:

- **Railway:** a *Railway Volume* mounted at `/data` (dashboard), if you use the
  on-disk JSON/uploads path at all. The product path uses managed Postgres (#127)
  + R2 object storage (#128), so a volume is optional there.
- **compose / plain docker:** the `-v spieleabend-data:/data` mount we already
  document in `docker-compose.yml` and the README. These give the volume
  explicitly, so dropping the `VOLUME` line changes nothing for them. (The only
  behavioural change: a bare `docker run` with **no** `-v` now writes to the
  container layer instead of an anonymous volume — but every documented run mounts
  one, and anonymous volumes are an anti-pattern anyway.)

`test/docker.test.js` guards this: it asserts the Dockerfile keeps `DATA_DIR=/data`
**and contains no `VOLUME`**, so re-adding one (which would re-break Railway) fails
the suite. `mkdir -p /data && chown node:node /data` stays — it makes whatever is
mounted at `/data` (or the container fs) writable by the non-root `node` user.
