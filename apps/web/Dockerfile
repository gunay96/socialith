# Build context MUST be the monorepo root (docker build -f apps/web/Dockerfile .)
# NEXT_PUBLIC_* vars are inlined at build time, not read at container start
# — pass them as --build-arg or bake a real apps/web/.env.production.local
# into the build context before running this, matching Next.js's own
# documented behavior. There is no way around this short of a runtime
# proxy rewriting the built JS, which this repo does not do.
FROM node:20-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/upload-post/package.json ./packages/upload-post/package.json
COPY packages/publishing/package.json ./packages/publishing/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/video-engine/package.json ./packages/video-engine/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm --filter @socialith/web... build

FROM node:20-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["pnpm", "--filter", "@socialith/web", "start"]
