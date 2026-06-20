# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage build — npm workspaces (no pnpm dependency)
#
# Stage 1 (builder): install all deps, compile TS for all three packages
# Stage 2 (production): only the server runtime + pre-built client static files
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine AS builder
WORKDIR /app

# Copy workspace manifests first — Docker layer cache skips re-install when
# only source files change.
COPY package.json package-lock.json ./
COPY packages/crdt-core/package.json ./packages/crdt-core/
COPY packages/client/package.json    ./packages/client/
COPY packages/server/package.json    ./packages/server/
COPY tsconfig.base.json              ./

# --ignore-scripts skips the sqlite3 native build in the builder stage;
# the production stage will install prod-only deps fresh.
RUN npm ci --ignore-scripts

# Copy source and compile every package in dependency order.
COPY . .
RUN npm run build --workspace=packages/crdt-core
RUN npm run build --workspace=packages/client
RUN npm run build --workspace=packages/server

# ─────────────────────────────────────────────────────────────────────────────
# Production image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Install build tools for sqlite3 native module, then clean up.
RUN apk add --no-cache python3 make g++ \
 && npm install -g npm@latest

COPY package.json package-lock.json ./
COPY packages/crdt-core/package.json ./packages/crdt-core/
COPY packages/server/package.json    ./packages/server/

# Install PRODUCTION dependencies only (builds sqlite3 native here).
RUN npm ci --omit=dev --workspace=packages/crdt-core --workspace=packages/server

# Copy compiled outputs from builder.
COPY --from=builder /app/packages/crdt-core/dist ./packages/crdt-core/dist
COPY --from=builder /app/packages/server/dist    ./packages/server/dist

# Copy static client build (served externally by nginx in prod, but available
# here if you want the server to serve it via express.static).
COPY --from=builder /app/packages/client/dist    ./packages/client/dist

# Point crdt-core exports to the compiled dist so the server can require it.
RUN node -e "const p=require('./packages/crdt-core/package.json'); \
  p.main='./dist/index.js'; p.types='./dist/index.d.ts'; \
  p.exports={'.':{'import':'./dist/index.js','types':'./dist/index.d.ts'}}; \
  require('fs').writeFileSync('./packages/crdt-core/package.json',JSON.stringify(p,null,2));"

# Non-root user + persistent data volume.
RUN mkdir -p /data && chown node:node /data
USER node

ENV NODE_ENV=production \
    PORT=3001 \
    DB_PATH=/data/data.db \
    CORS_ORIGIN=http://localhost:5173

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "packages/server/dist/index.js"]
