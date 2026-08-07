FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/tg-gateway/package.json apps/tg-gateway/
COPY apps/api/package.json apps/api/
COPY apps/workers-ts/package.json apps/workers-ts/
RUN pnpm install --filter @alo/shared --filter @alo/tg-gateway...

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/tg-gateway apps/tg-gateway
RUN pnpm --filter @alo/shared build && pnpm --filter @alo/tg-gateway build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=build /app /app
WORKDIR /app/apps/tg-gateway
CMD ["node", "dist/index.js"]
