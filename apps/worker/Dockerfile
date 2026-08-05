FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile --filter @myev/worker...

FROM base AS build
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY apps/worker apps/worker
WORKDIR /repo/apps/worker
RUN pnpm build

FROM node:24-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/worker
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
