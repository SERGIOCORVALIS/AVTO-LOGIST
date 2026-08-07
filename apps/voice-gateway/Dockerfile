FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/voice-gateway/package.json apps/voice-gateway/
RUN pnpm install --filter @alo/shared --filter @alo/voice-gateway...

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/prompts packages/prompts
COPY apps/voice-gateway apps/voice-gateway
RUN pnpm --filter @alo/shared build && pnpm --filter @alo/voice-gateway build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=build /app /app
WORKDIR /app/apps/voice-gateway
EXPOSE 3010
CMD ["node", "dist/index.js"]
