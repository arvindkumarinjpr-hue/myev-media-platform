# Node.js 24 LTS — approved technology baseline, matches the live CloudPanel
# runtime on app.myevmedia.com.
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @myev/api... --filter @myev/shared

FROM base AS build
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/shared packages/shared
WORKDIR /repo/apps/api
RUN pnpm prisma:generate
RUN pnpm build

FROM node:24-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/main.js"]
