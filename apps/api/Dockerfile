# Build context MUST be the monorepo root (docker build -f apps/api/Dockerfile .)
# — pnpm workspaces need every package.json present to resolve
# workspace:* dependencies, so a single-app context can't work here.
FROM node:20-slim AS base
# Real, verified requirement (not precautionary): node:20-slim is Debian
# bookworm, which ships OpenSSL 3.x with no `openssl` CLI installed at
# all. Without it, Prisma's own OS-detection can't identify the real
# OpenSSL version at `prisma generate` time and silently guesses the
# wrong engine binary (debian-openssl-1.1.x, which bookworm doesn't even
# have libssl.so.1.1 for) — this was caught as a real crash-looping
# container during this phase's Docker E2E pass, not assumed in advance.
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
RUN pnpm --filter @socialith/api... build

# Real runtime stage: ffmpeg is required by @socialith/video-engine even
# though the API process itself never renders video — the worker image
# below is the one that actually shells out to it. Kept out of the API
# image to keep it smaller; nothing under apps/api/src calls ffmpeg.
# openssl is required here too — the Prisma query engine binary itself
# dlopen()s libssl.so.3 at runtime, not just at generate time.
FROM node:20-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 4000
CMD ["node", "apps/api/dist/bootstrap.js"]
