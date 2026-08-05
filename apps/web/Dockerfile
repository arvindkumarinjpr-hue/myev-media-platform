FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @myev/web...

FROM base AS build
COPY --from=deps /repo /repo
COPY apps/web apps/web
WORKDIR /repo/apps/web
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
