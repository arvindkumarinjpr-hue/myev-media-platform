FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
ENV CI=true
RUN pnpm config set store-dir /pnpm-store && \
    pnpm config set fetch-retries 5 && \
    pnpm config set fetch-timeout 120000
WORKDIR /repo

# ---- fetch: shared store, same cache id as api/web Dockerfiles ----
FROM base AS fetch
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm fetch --frozen-lockfile

# ---- deps: link node_modules (dev+prod) from the fetched store — no network ----
# All workspace member package.json files needed for pnpm to resolve
# --filter correctly against the lockfile (see apps/api/Dockerfile for the
# full explanation).
FROM fetch AS deps
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --offline --frozen-lockfile --filter @myev/worker...

# ---- build: compile TS ----
FROM base AS build
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY apps/worker apps/worker
WORKDIR /repo/apps/worker
RUN pnpm build

# ---- deploy: pruned production dependency tree (see apps/api/Dockerfile) ----
FROM build AS deploy
WORKDIR /repo
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm --filter=@myev/worker deploy --prod --legacy /deploy-out

# ---- runtime: minimal image ----
FROM node:24-alpine AS runtime
WORKDIR /repo/apps/worker
COPY --from=deploy /deploy-out/node_modules ./node_modules
COPY --from=deploy /deploy-out/package.json ./package.json
COPY --from=deploy /deploy-out/dist ./dist
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
