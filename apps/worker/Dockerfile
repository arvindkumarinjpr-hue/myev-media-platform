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
COPY apps/render-worker/package.json apps/render-worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/worker-core/package.json packages/worker-core/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --offline --frozen-lockfile --filter @myev/worker... --filter @myev/api...

# ---- build: compile @myev/shared -> @myev/worker-core -> apps/worker ----
# Both packages' package.json main/types point at ./dist, so a workspace
# dependency consumed at the VALUE level (not just types) must already be
# plain JS by the time apps/worker's tsc resolves it.
FROM base AS build
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
WORKDIR /repo/packages/shared
RUN pnpm build
COPY packages/worker-core /repo/packages/worker-core
WORKDIR /repo/packages/worker-core
RUN pnpm prisma:generate && pnpm build
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
# Module 7 Phase 7.7 staging deployment discovered this the hard way:
# `pnpm deploy --legacy` (required above — this workspace's workspace:*
# deps have no inject-workspace-packages=true) does NOT symlink
# @myev/worker-core the way a plain `pnpm install` does; it isolates it
# into a REAL directory nested under
# node_modules/.pnpm/@myev+worker-core@<hash>/node_modules/@myev/worker-core/.
# @myev/worker-core's compiled prisma.service.js still does a
# SOURCE-TREE-relative `require("../../../../apps/api/generated/prisma")`
# — correct 4 levels up from packages/worker-core/src/prisma/ (or from a
# plain symlink, which Node resolves via the symlink's real target), but
# from this isolated deploy location 4 levels up lands at
# .../node_modules/.pnpm/@myev+worker-core@<hash>/node_modules/ instead of
# the repo root, which doesn't have apps/api/generated — MODULE_NOT_FOUND
# at boot. Bridge exactly that nested node_modules back to the real
# apps/api/generated this stage already copied in above.
RUN nested_nm="$(find ./node_modules/.pnpm -maxdepth 2 -type d -name node_modules -path '*/@myev+worker-core@*' | head -1)" && \
    test -n "$nested_nm" && \
    mkdir -p "$nested_nm/apps/api" && \
    ln -s /repo/apps/api/generated "$nested_nm/apps/api/generated"
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
