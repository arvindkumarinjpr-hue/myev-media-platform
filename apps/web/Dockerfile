FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
ENV CI=true
RUN pnpm config set store-dir /pnpm-store && \
    pnpm config set fetch-retries 5 && \
    pnpm config set fetch-timeout 120000
WORKDIR /repo

# ---- fetch: shared store, same cache id as api/worker Dockerfiles ----
FROM base AS fetch
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm fetch --frozen-lockfile

# ---- deps: link node_modules from the fetched store — no network ----
# All workspace member package.json files needed for pnpm to resolve
# --filter correctly against the lockfile (see apps/api/Dockerfile for the
# full explanation of the bug this avoids).
FROM fetch AS deps
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --offline --frozen-lockfile --filter @myev/web...

FROM base AS build
COPY --from=deps /repo /repo
COPY apps/web apps/web
WORKDIR /repo/apps/web
RUN pnpm build

# Next.js `output: "standalone"` already produces a minimal, self-contained
# runtime (traced dependency subset only) — no separate prod-deps stage
# needed here, unlike api/worker. Nothing dev-only (webpack, eslint, the
# TypeScript compiler) is present in the standalone output.
FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
