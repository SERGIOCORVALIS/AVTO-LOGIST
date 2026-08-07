FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/workers-ts/package.json apps/workers-ts/
COPY apps/api/package.json apps/api/
COPY apps/tg-gateway/package.json apps/tg-gateway/
RUN pnpm install --filter @alo/shared --filter @alo/workers-ts...

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/workers-ts apps/workers-ts
RUN pnpm --filter @alo/shared build && pnpm --filter @alo/workers-ts build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=build /app /app
WORKDIR /app/apps/workers-ts
CMD ["node", "dist/index.js"]
