# Module 7 Phase 7.5 — the dedicated render / media worker image.
#
# Debian (NOT alpine): Remotion's headless browser (Chrome Headless Shell)
# requires glibc. This image is deliberately separate from the general
# apps/worker image (node:24-alpine, no browser) — the whole point of the
# render-worker extraction is that Chromium / Remotion never enter the
# general worker.
FROM node:24-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
ENV CI=true
RUN pnpm config set store-dir /pnpm-store && pnpm config set fetch-retries 5 && pnpm config set fetch-timeout 120000
WORKDIR /repo

# ---- fetch ----
FROM base AS fetch
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked pnpm fetch --frozen-lockfile

# ---- deps ----
FROM fetch AS deps
COPY apps/api/package.json apps/api/package.json
COPY apps/api/prisma apps/api/prisma
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/render-worker/package.json apps/render-worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/worker-core/package.json packages/worker-core/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --offline --frozen-lockfile --filter @myev/render-worker... --filter @myev/api...

# ---- build: compile shared -> worker-core -> render-worker ----
FROM base AS build
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
WORKDIR /repo/packages/shared
RUN pnpm build
COPY packages/worker-core /repo/packages/worker-core
WORKDIR /repo/packages/worker-core
RUN pnpm prisma:generate && pnpm build
COPY apps/render-worker /repo/apps/render-worker
WORKDIR /repo/apps/render-worker
RUN pnpm prisma:generate && pnpm build

# ---- smoke: the REAL Remotion production render, run in-image ----
# Section §F/§G: a production render path that has never run cannot be
# approved, and the CI runner can't reliably do Chromium — so the smoke
# runs here, inside the render-worker image (dev deps + jest present in
# the `build` stage; Chromium + fonts installed below).
FROM build AS smoke
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 libatk-bridge2.0-0 \
      libcups2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 \
      libpango-1.0-0 libcairo2 libatspi2.0-0 libxrender1 libxext6 libx11-6 \
      fonts-liberation fontconfig \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo/apps/render-worker
RUN node -e "require('@remotion/renderer').ensureBrowser()"
RUN pnpm smoke:remotion

# ---- deploy: pruned production tree ----
FROM build AS deploy
WORKDIR /repo
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm --filter=@myev/render-worker deploy --prod --legacy /deploy-out

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime

# Remotion / Chrome Headless Shell system libraries + fonts. Only what
# the headless renderer genuinely needs — verified against Remotion
# 4.0.x's documented Linux dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 libatk-bridge2.0-0 \
      libcups2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 \
      libpango-1.0-0 libcairo2 libatspi2.0-0 libxrender1 libxext6 libx11-6 \
      fonts-liberation fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo/apps/render-worker
COPY --from=deploy /deploy-out/node_modules ./node_modules
COPY --from=deploy /deploy-out/package.json ./package.json
COPY --from=deploy /deploy-out/dist ./dist
# The Remotion composition is bundled from SOURCE by @remotion/bundler at
# render time — ship the .tsx sources and point the engine at them.
COPY --from=build /repo/apps/render-worker/src/render/remotion ./src/render/remotion
# The generated Prisma client lives in the sibling apps/api/generated.
COPY --from=build /repo/apps/api/generated /repo/apps/api/generated
# Module 7 Phase 7.7 staging deployment discovered this the hard way (see
# apps/worker/Dockerfile's identical fix for the full explanation):
# `pnpm deploy --legacy` isolates @myev/worker-core into a real directory
# nested under node_modules/.pnpm/@myev+worker-core@<hash>/node_modules/,
# from which its compiled prisma.service.js's source-tree-relative
# `require("../../../../apps/api/generated/prisma")` no longer reaches
# the repo root — MODULE_NOT_FOUND at boot. Bridge that exact nested
# node_modules back to the real apps/api/generated copied in above.
RUN nested_nm="$(find ./node_modules/.pnpm -maxdepth 2 -type d -name node_modules -path '*/@myev+worker-core@*' | head -1)" && \
    test -n "$nested_nm" && \
    mkdir -p "$nested_nm/apps/api" && \
    ln -s /repo/apps/api/generated "$nested_nm/apps/api/generated"

ENV NODE_ENV=production
ENV RENDER_ENGINE=remotion
ENV REMOTION_ENTRY=/repo/apps/render-worker/src/render/remotion/index.tsx

# Pre-download Chrome Headless Shell into the image so the first render
# doesn't pay the download cost (and a locked-down runtime with no egress
# still works).
RUN node -e "require('@remotion/renderer').ensureBrowser()"

CMD ["node", "dist/main.js"]
