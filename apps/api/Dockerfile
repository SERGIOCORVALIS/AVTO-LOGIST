FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/tg-gateway/package.json apps/tg-gateway/
COPY apps/workers-ts/package.json apps/workers-ts/
RUN pnpm install --filter @alo/shared --filter @alo/api...

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @alo/shared build && pnpm --filter @alo/api build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=build /app /app
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/index.js"]
