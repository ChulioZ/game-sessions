# syntax=docker/dockerfile:1

# Production container for Spieleabend — a small, host-agnostic runtime configured
# entirely via env (PORT, DATA_DIR, DATABASE_URL, S3_*, AUTH_*, …; see .env.example).
# TLS is NOT handled here: it terminates at the reverse proxy / platform in front
# of this container (set TRUST_PROXY there so the rate limiter keys on the real
# client IP) — see issue #156. Persistence and uploads live on a mounted /data
# volume unless DATABASE_URL / S3_BUCKET point them elsewhere.

# ---- build stage: install all deps and produce the content-hashed assets ----
# The optional cache-busting build (`npm run build`, issue #141) mirrors public/
# into dist/ with hashed, minified JS/CSS, so a production deploy serves
# self-invalidating assets. It needs the devDependency esbuild, which stays in this
# throwaway stage and never reaches the final image.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage: production deps + source + built assets, nothing else ----
FROM node:22-slim
ENV NODE_ENV=production
# Serve data from a stable, mountable path (a volume / managed disk), not the
# in-image working directory, so user data survives container restarts and
# redeploys. Overridable, like every other setting, via env.
ENV DATA_DIR=/data
WORKDIR /app

# Only production dependencies in the final image (no esbuild / eslint / supertest).
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source, then the built assets from the build stage. NODE_ENV=production makes
# lib/app.js serve dist/ when dist/index.html exists (issue #141), else public/.
COPY . .
COPY --from=build /app/dist ./dist

# Run as the unprivileged built-in `node` user; pre-create the data directory it
# writes rounds/uploads to, so whatever gets mounted at /data (a Railway Volume, a
# compose/`-v` volume) — or the container fs itself — is owned by `node`.
# NOTE: intentionally no Dockerfile `VOLUME /data` — Railway's Metal builder
# rejects the VOLUME instruction ("use Railway Volumes"). Persistence is attached
# at the platform level instead; the instruction was only a hint and isn't needed.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000
# Liveness/readiness: hit the unauthenticated, un-rate-limited /healthz (lib/app.js).
# PORT is read at runtime so a custom port is still probed correctly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
