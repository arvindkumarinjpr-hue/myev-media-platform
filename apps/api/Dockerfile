# Node.js 24 LTS — approved technology baseline, matches the live CloudPanel
# runtime on app.myevmedia.com.
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
ENV CI=true
RUN pnpm config set store-dir /pnpm-store && \
    pnpm config set fetch-retries 5 && \
    pnpm config set fetch-timeout 120000
WORKDIR /repo

# ---- fetch: populate the shared pnpm store from the lockfile ONLY ----
# Uses a STABLE, EXPLICIT cache id ("pnpm-store") shared across the api,
# web, and worker Dockerfiles. `pnpm fetch` needs only the lockfile (no
# per-app package.json), downloads everything the whole workspace lockfile
# references, and is idempotent against the shared store — whichever of the
# three service builds runs first pays the network cost; the other two find
# their packages already present and skip the network entirely. This is the
# fix for "repeated registry downloads across web/api/worker Docker targets"
# (Module 1A.1 hardening correction), not just a retry/timeout workaround.
FROM base AS fetch
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm fetch --frozen-lockfile

# ---- deps: link node_modules (dev+prod) from the already-fetched store — no network ----
# pnpm needs EVERY workspace member's package.json present (even ones not
# being built) to correctly resolve `--filter` against the lockfile's full
# importer graph — omitting web/worker here was tried and caused pnpm to
# silently fall back to linking the entire monorepo dependency graph.
FROM fetch AS deps
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
# schema.prisma is needed here too: our own `postinstall: prisma generate`
# script (apps/api/package.json) runs during `pnpm install` below, before
# the "build" stage's full `COPY apps/api apps/api` has happened.
COPY apps/api/prisma apps/api/prisma
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --offline --frozen-lockfile --filter @myev/api... --filter @myev/shared

# ---- build: compile TS, generate Prisma client ----
FROM base AS build
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/shared packages/shared
WORKDIR /repo/apps/api
RUN pnpm prisma:generate
RUN pnpm build

# ---- deploy: pnpm's purpose-built pruning for exactly this scenario ----
# `pnpm install --filter --prod` was tried first and rejected: pnpm's
# isolated linker hard-links the ENTIRE lockfile's resolved graph into the
# shared workspace-root `.pnpm` store regardless of --filter (Next.js,
# sharp, the `prisma` CLI, and TypeScript all remained present, ~800MB).
# `pnpm deploy` genuinely prunes to just this package's production
# dependency tree — measured 281MB with zero dev tooling present.
# --legacy: this workspace uses `workspace:*` deps (@myev/shared) without
# `inject-workspace-packages=true` configured; --legacy is pnpm's supported
# deploy mode for that case.
FROM build AS deploy
WORKDIR /repo
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm --filter=@myev/api deploy --prod --legacy /deploy-out

# ---- runtime: minimal image — no dev tooling present at all ----
FROM node:24-alpine AS runtime
WORKDIR /repo/apps/api
COPY --from=deploy /deploy-out/node_modules ./node_modules
COPY --from=deploy /deploy-out/package.json ./package.json
COPY --from=deploy /deploy-out/dist ./dist
# Custom-output Prisma client (schema.prisma `output`) — a stable path,
# independent of pnpm's hashed virtual store.
COPY --from=deploy /deploy-out/generated ./generated
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/main.js"]
