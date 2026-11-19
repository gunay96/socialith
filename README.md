# Socialith

Socialith is an independent social-media-automation SaaS platform for
scheduling, publishing, and analyzing content across TikTok, Instagram,
and YouTube — including real OAuth account connections, AI caption
generation, FFmpeg video rendering, music/sound-based campaign tracking,
and automated analytics sync. It is **not** an influencer CRM.

See [`docs/architecture.md`](./docs/architecture.md) for the system
design and data model.

## Stack

- **Web**: Next.js 14, TypeScript, Tailwind CSS
- **API**: Node.js, Express, TypeScript
- **Worker**: Node.js, BullMQ, TypeScript
- **Database**: PostgreSQL + Prisma
- **Queue**: Redis + BullMQ
- **Object storage**: local disk (dev) or Cloudflare R2 / S3-compatible (production)
- **Monorepo**: pnpm workspaces + Turborepo

## Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (`corepack enable` will install it automatically)
- Docker (for local Postgres + Redis)
- FFmpeg on `PATH` (or set `FFMPEG_PATH`) — required by the worker's video-render pipeline

## Getting started (local development)

```bash
cp .env.example .env
# Generate a real SESSION_SECRET and TOKEN_ENCRYPTION_KEY (see "Environment
# variables" below) before doing anything beyond a throwaway local run.

pnpm install
pnpm docker:up          # starts Postgres + Redis (dev-only compose file)
pnpm db:generate        # generates the Prisma client
pnpm db:migrate         # applies migrations (prisma migrate dev)
pnpm db:seed            # seeds one organization + owner user

pnpm dev                # runs web, api, and worker together via turbo
```

- Web: http://localhost:3000
- API health check: http://localhost:4000/health (reports Postgres/Redis reachability + real per-queue backlog counts)
- Worker health check: http://localhost:4100/health (reports readiness per BullMQ worker)

## Environment variables

`.env.example` is the source of truth, with inline comments on every
variable. Summary by area:

| Area | Variables | Notes |
|---|---|---|
| Core | `DATABASE_URL`, `REDIS_URL`, `API_PORT`, `WORKER_PORT`, `NODE_ENV` | Required. |
| App URLs | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, `API_PUBLIC_URL` | `NEXT_PUBLIC_APP_URL` is **required and must not be localhost** when `NODE_ENV=production` — used as the sole allowed CORS origin. |
| Sessions/auth | `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` | `TOKEN_ENCRYPTION_KEY` must be exactly 64 hex chars (32 bytes) — encrypts every stored OAuth token at rest. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| Email | `EMAIL_PROVIDER` | `"console"` (logs instead of sending) is the only implemented provider today. |
| OAuth — TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` | See [`docs/setup-tiktok.md`](./docs/setup-tiktok.md). |
| OAuth — Meta/Instagram | `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` | See [`docs/setup-meta.md`](./docs/setup-meta.md). |
| OAuth — Google/YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | See [`docs/setup-youtube.md`](./docs/setup-youtube.md). |
| Storage | `LOCAL_STORAGE_DIR`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` | R2 activates automatically once the three required R2 vars are set. See [`docs/setup-r2.md`](./docs/setup-r2.md). |
| Video render | `FFMPEG_PATH` | Defaults to `ffmpeg` on `PATH`. |
| AI generation | `AI_PROVIDER_API_KEY`, `AI_PROVIDER_BASE_URL`, `AI_PROVIDER_MODEL`, `AI_PROVIDER_TIMEOUT_MS`, `AI_PROVIDER_COST_PER_1K_PROMPT_TOKENS_USD`, `AI_PROVIDER_COST_PER_1K_COMPLETION_TOKENS_USD` | Assumes an OpenAI-compatible chat-completions API. Missing key → real `CONFIGURATION_ERROR`, never a fabricated caption. |
| Rate limits | `AI_PROVIDER_RATE_LIMIT_MAX/_DURATION_MS`, `PUBLISHING_RATE_LIMIT_MAX/_DURATION_MS`, `ANALYTICS_SYNC_RATE_LIMIT_MAX/_DURATION_MS`, `TOKEN_REFRESH_RATE_LIMIT_MAX/_DURATION_MS` | Per-queue BullMQ `limiter` caps — tune to your actual platform app tier's real rate limits. |

**Never commit a real `.env`** — it's gitignored. Production secrets live
only in your deployment platform's secret store / a `.env` file that
never enters version control (see `docker-compose.prod.yml`'s `env_file`
usage).

## Database setup

```bash
pnpm docker:up                # Postgres + Redis via docker-compose.yml (dev)
pnpm db:generate               # prisma generate
pnpm db:migrate                 # prisma migrate dev — applies + creates migrations
pnpm db:seed                    # seeds one organization + OWNER user (see packages/database/prisma/seed.ts)
```

For a production database, run `pnpm --filter @socialith/database exec prisma migrate deploy`
against the real `DATABASE_URL` instead of `migrate dev` (never runs the
interactive dev-migration flow, applies only already-committed migrations).

## Worker setup

The worker (`apps/worker`) runs BullMQ consumers for content generation,
video rendering, publishing, analytics sync, and scheduled token refresh —
see `apps/worker/src/index.ts` for the full list of queues and
`docs/architecture.md` for what each one owns. It needs the same
`DATABASE_URL`/`REDIS_URL` as the API, plus `FFMPEG_PATH` if FFmpeg isn't
on `PATH`. Run it with `pnpm --filter @socialith/worker dev` (or as part
of `pnpm dev`), or in production as its own container
(`apps/worker/Dockerfile`) — it does **not** need to run on the same host
as the API; both only need to reach the same Postgres and Redis.

## Platform capability matrix

`GET /api/platform-capabilities` (and the "What's supported?" panel on
`/accounts`) reflects `packages/types/src/platform-capabilities.ts` — a
real, research-cited matrix of what each platform's official API
currently supports for video/photo publishing, analytics, and sound
attachment, with `SUPPORTED` / `PARTIAL` / `REQUIRES_APPROVAL` /
`NOT_SUPPORTED` / `NOT_APPLICABLE` per capability. Nothing here is
guessed — see the file's own comments for what was verified where.

## Deployment

Two docker-compose files:

- `docker-compose.yml` — **dev only**: Postgres + Redis. Apps run via
  `pnpm dev` against them.
- `docker-compose.prod.yml` — **production**: Postgres + Redis + API +
  worker + web, each with its own `Dockerfile`
  (`apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/web/Dockerfile`).
  Secrets are read from a real `.env` via `env_file`, never baked into the
  image or the compose file itself.

```bash
pnpm docker:prod:up      # docker compose -f docker-compose.prod.yml --env-file .env up -d --build
pnpm docker:prod:down
```

`NEXT_PUBLIC_API_URL` is inlined into the web build at build time (a
Next.js constraint, not a Socialith limitation) — the compose file passes
it as a build arg from your `.env`.

For the real `socialith.co` production deployment specifically
(single-domain reverse-proxy topology, real env var values, TikTok
Developer Portal settings, post-deploy E2E checklist), see
[`docs/deployment-guzelhosting.md`](./docs/deployment-guzelhosting.md).

For the no-VPS, no-Docker, no-SSH, no-Redis/worker shared cPanel
demo/production-lite tier (Setup Node.js App only), see
[`docs/deployment-guzelhosting-shared.md`](./docs/deployment-guzelhosting-shared.md).

## CI

`.github/workflows/ci.yml` runs, on every PR/push to `main`: install →
lint → typecheck → Prisma generate → Prisma migrate deploy (against
ephemeral Postgres/Redis service containers) → test → build.

## Scripts (root)

| Script | What it does |
|---|---|
| `pnpm dev` | Run all apps in dev mode |
| `pnpm build` | Build all apps/packages |
| `pnpm lint` | Lint all apps/packages |
| `pnpm typecheck` | `tsc --noEmit` across all apps/packages |
| `pnpm test` | Run all test suites (vitest) |
| `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:seed` | Prisma commands, scoped to `@socialith/database` |
| `pnpm docker:up` / `pnpm docker:down` | Local dev Postgres + Redis |
| `pnpm docker:prod:up` / `pnpm docker:prod:down` | Full production stack (Postgres + Redis + API + worker + web) |

## Security notes

- Every OAuth token is encrypted at rest (AES-256-GCM,
  `TOKEN_ENCRYPTION_KEY`) — the publishing/analytics/token-refresh workers
  never read a raw token from the database directly, only through
  `apps/worker/src/publishing/token.ts`'s centralized resolver.
  See [`docs/architecture.md`](./docs/architecture.md).
- Organization isolation is enforced at the repository layer everywhere —
  a cross-organization resource ID returns 404, never 403 (no existence
  signal leaks across tenants).
- Rate limiting exists at the API layer (login/forgot-password/
  reset-password/general/OAuth) and at the worker's queue layer (per
  provider — see the table above).
- Real per-provider error codes (`CONFIGURATION_ERROR`, `REAUTH_REQUIRED`,
  `TOKEN_EXPIRED`, `RATE_LIMITED`, `PLATFORM_PERMISSION_MISSING`, ...) are
  used throughout instead of a generic failure message — see
  `packages/types/src/index.ts`'s `ERROR_CODES`.
