# Deploying to Railway (production)

The production target is [Railway](https://railway.com). It builds the repo's
`Dockerfile` (config in [`railway.json`](../railway.json)) and auto-deploys on
push to `main`, so the container we publish is what runs. This is the "deploy"
half of issue #131 and it also satisfies the TLS work (#156) — Railway terminates
TLS at its edge.

## The production shape

Unlike the local/home setup (JSON file + on-disk uploads), a hosted deployment
uses the **stateless app-tier** backends the repo already ships, so the container
holds no state and can be redeployed/scaled freely:

- **Data → managed PostgreSQL** (`DATABASE_URL`, the #127 backend) instead of
  `data/data.json`.
- **Cover images → Cloudflare R2** (S3-compatible, the #128 backend via
  `S3_ENDPOINT`) instead of local `data/uploads/`. Railway has no native object
  storage; R2 (or Backblaze B2) is the cheap, S3-compatible pairing. The app only
  ever stores the `/uploads/<key>` path and streams bytes through itself, so
  nothing changes but where the bytes live.
- **TLS + real client IP** — Railway serves the app over HTTPS at its edge and
  forwards plain HTTP to the container. Set `TRUST_PROXY=1` so the rate limiter
  and the `Secure` session cookie key off the real client IP (#156).

Everything is configured with the same env vars documented in
[`.env.example`](../.env.example) — no code changes to switch backends.

## Steps

### 1. Create the project (auto-deploy from GitHub)

1. In Railway, **New Project → Deploy from GitHub repo**, pick this repo.
2. Choose an **EU region** (e.g. `europe-west4`, Amsterdam) so user data stays in
   the EU — simplest under DSGVO and consistent with the Impressum/privacy work
   (#134).
3. Railway detects the `Dockerfile` and `railway.json`, builds the image, and
   redeploys on every push to `main`. The deploy is health-checked at `/healthz`.

### 2. Add managed PostgreSQL

1. In the project, **New → Database → PostgreSQL**.
2. In the **app service → Variables**, add `DATABASE_URL` referencing the DB, e.g.
   `${{Postgres.DATABASE_URL}}`. The app creates its schema on first boot.
3. Add `DATABASE_SSL=true` if you connect over Railway's **public** Postgres
   endpoint (managed Postgres over the internet requires TLS); over the project's
   **private** network it is usually not needed. Start with it set; drop it only
   if the driver reports the server doesn't support SSL.
4. *(Optional hardening, #136)* the round tables are protected by **Row-Level
   Security**, but Postgres **superusers bypass RLS entirely** — and Railway's
   default `postgres` user is one. The app's own queries are tenant-filtered
   either way; for the database-level backstop to actually bind, run the app as
   a dedicated **non-superuser role that owns the tables** (`FORCE ROW LEVEL
   SECURITY` binds owners, and ownership lets `repo.init()` keep managing the
   schema/policies on boot), then point `DATABASE_URL` at it:

   ```sql
   CREATE ROLE spieleabend_app LOGIN PASSWORD '<generate one>';
   GRANT CONNECT ON DATABASE railway TO spieleabend_app;
   GRANT USAGE, CREATE ON SCHEMA public TO spieleabend_app;
   ALTER TABLE rounds     OWNER TO spieleabend_app;
   ALTER TABLE members    OWNER TO spieleabend_app;
   ALTER TABLE games      OWNER TO spieleabend_app;
   ALTER TABLE sessions   OWNER TO spieleabend_app;
   ALTER TABLE activities OWNER TO spieleabend_app;
   ALTER TABLE users      OWNER TO spieleabend_app;
   ```

   (On a fresh database the `ALTER TABLE … OWNER` lines are unnecessary — the
   app role creates the tables itself on first boot and owns them from the
   start.)

### 3. Add object storage (Cloudflare R2)

1. In Cloudflare, create an **R2 bucket** and an **API token** (Access Key ID +
   Secret Access Key) scoped to it.
2. In the app service → Variables, set:
   - `S3_BUCKET` = your bucket name
   - `S3_ENDPOINT` = `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - `S3_REGION` = `auto`
   - `S3_FORCE_PATH_STYLE` = `true`
   - `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` = the R2 token pair

*(Simplest-start alternative: attach a Railway **volume** mounted at `/data` and
skip R2 — uploads then live on the volume. It works, but a volume pins the service
to one replica, so it can't scale horizontally. Prefer R2 for the product path.)*

### 4. Set the proxy + protect the instance

- `TRUST_PROXY=1` — **required** behind Railway's edge (see above).
- **Gate the app until accounts land.** The app has **no authentication yet** (the
  account model is #135) — a public URL would expose the group's data to anyone.
  Until then, set `AUTH_PASSWORD` (the single shared-login gate, #129) **and** a
  long random `SESSION_SECRET` so an unauthenticated visitor only gets the login
  page. Don't put this instance on the public internet without it.

### 5. Custom domain

Add your domain in the app service → **Settings → Networking → Custom Domain** and
point the DNS record Railway shows you. Railway issues and renews the TLS
certificate automatically — this completes #156.

## Env var summary

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Managed Postgres backend (#127) |
| `DATABASE_SSL` | `true` (public endpoint) | TLS to the DB |
| `S3_BUCKET` / `S3_ENDPOINT` / `S3_REGION` / `S3_FORCE_PATH_STYLE` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | R2 bucket + token | Cover-image storage (#128) |
| `TRUST_PROXY` | `1` | Real client IP behind Railway's proxy (#156) |
| `AUTH_PASSWORD` / `SESSION_SECRET` | your choice / long random | Interim gate until accounts (#135) |
| `PORT` | *(injected by Railway)* | The app already honours it |

`NODE_ENV=production` is baked into the image (serves the hashed `dist/` build).
Other optional tuning (`LOG_LEVEL`, `RATE_LIMIT_MAX`, `ERROR_WEBHOOK_URL`, …) is in
[`.env.example`](../.env.example).

## What only you can do (checklist)

These need an account or a credential I can't create or hold:

- [ ] Create the **Railway** account + project; connect this repo; pick an **EU region**.
- [ ] Add the **PostgreSQL** service and reference `DATABASE_URL` in the app.
- [ ] Create the **Cloudflare R2** bucket + API token; set the `S3_*` vars.
- [ ] Set `TRUST_PROXY=1`, and `AUTH_PASSWORD` + `SESSION_SECRET` before any public URL.
- [ ] Add the **custom domain** and its DNS record.

## CD note

Railway's native GitHub integration *is* the CD pipeline (build + deploy on push
to `main`), so no GitHub Actions deploy job is needed — the repo's `Docker`
workflow keeps building/publishing the image to GHCR for portability and as an
independent build check. If you'd rather drive deploys from GitHub Actions
instead, that's a `railway up` step gated on a `RAILWAY_TOKEN` secret — ask and
it's a small addition.
