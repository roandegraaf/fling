# syntax=docker/dockerfile:1

# ── build: compile the SPA and the server ────────────────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 falls back to compiling from source when no prebuild matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY . .
RUN npm run build

# ── deps: production-only node_modules ───────────────────────────────────────
FROM node:24-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev && npm cache clean --force

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    FLING_CONFIG_DIR=/config \
    FLING_DATA_DIR=/data \
    FLING_PORT=8080 \
    FLING_HOST=0.0.0.0

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/server/dist  ./server/dist
COPY --from=build /app/web/dist     ./web/dist
COPY package.json        ./package.json
COPY server/package.json ./server/package.json

# /config — SQLite + master key (put this on a cache-backed appdata share)
# /data   — encrypted file blobs (put this on the share you want the files on)
VOLUME ["/config", "/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FLING_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM so shutdown stays clean.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
