# Build context MUST be the monorepo root (docker build -f apps/worker/Dockerfile .)
FROM node:20-slim AS base
# Real, verified requirement (not precautionary) — see apps/api/Dockerfile's
# identical comment: without `openssl` installed, Prisma's OS-detection
# guesses the wrong engine binary on Debian bookworm and the container
# crash-loops at boot.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
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
COPY packages/media-pack/package.json ./packages/media-pack/package.json
COPY packages/studio/package.json ./packages/studio/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/video-engine/package.json ./packages/video-engine/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @socialith/database generate
RUN pnpm --filter @socialith/worker... build

# Real runtime stage: ffmpeg is a genuine hard requirement here — the
# worker's video-render processor shells out to the real binary (see
# @socialith/config's FFMPEG_PATH, default "ffmpeg" on PATH). openssl is
# required too — the Prisma query engine binary dlopen()s libssl.so.3 at
# runtime, not just at generate time.
FROM node:20-slim AS runtime
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 4100
CMD ["node", "apps/worker/dist/bootstrap.js"]
