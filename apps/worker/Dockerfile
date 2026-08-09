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
# apps/api/prisma is needed here too: @myev/worker's own `postinstall`
# script (apps/worker/package.json) runs `prisma generate` (cwd apps/api)
# against apps/api/prisma/schema.prisma during `pnpm install` below — the
# Worker has no schema of its own, it generates its own client instance
# from the same single source-of-truth schema (see
# src/prisma/prisma.service.ts). @myev/api is included in this install's
# --filter (even though @myev/worker never imports it) because `prisma
# generate` needs apps/api's own node_modules (its `prisma`/`@prisma/client`
# devDependencies) actually installed — without them Prisma can't resolve
# a "project" at that schema's location and attempts a network self-install
# that fails under --offline.
FROM fetch AS deps
COPY apps/api/package.json apps/api/package.json
COPY apps/api/prisma apps/api/prisma
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --offline --frozen-lockfile --filter @myev/worker... --filter @myev/api...

# ---- build: compile TS, (re)generate the shared Prisma client ----
# packages/shared must be compiled BEFORE apps/worker — its package.json
# `main`/`types` point at ./dist (not raw .ts source: Node's native TS
# type-stripping refuses to run on files under node_modules, so a
# workspace dependency consumed at the VALUE level, not just as types,
# must already be plain JS by the time anything requires() it).
FROM base AS build
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
WORKDIR /repo/packages/shared
RUN pnpm build
COPY apps/worker /repo/apps/worker
WORKDIR /repo/apps/worker
RUN pnpm prisma:generate
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
# `pnpm deploy` only prunes @myev/worker's own package directory — the
# generated Prisma client lives in the sibling apps/api/generated (see
# src/prisma/prisma.service.ts's comment), so it must be copied in
# explicitly, preserving the same relative sibling layout the compiled
# dist's relative import expects.
COPY --from=build /repo/apps/api/generated /repo/apps/api/generated
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
