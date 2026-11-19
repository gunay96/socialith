# Socialith — Deployment Plan

Status: plan only. During this audit **no env var was changed, no container restarted,
no migration run.**

## 1. Current deployment reality

| Environment | State |
|---|---|
| Local Docker stack (`socialith-prod-*`) | Running, generation-1 images (Postgres/argon2/Redis-required), reachable via a **Cloudflare quick tunnel** (random URL, changes on restart). `api`, `web`, `postgres`, `redis`, `nginx`, `cloudflared` healthy; **`worker` crash-looping** (config-only cause, PROJECT_AUDIT §3). |
| Dev-only compose (`socialith-postgres`, `socialith-redis`) | Running; unused by the prod stack. |
| `socialith.co` | Serves an unrelated third-party site; **no Socialith deployment exists**. |
| cPanel ZIPs (`deploy-clean/*.zip`) | Built from the MySQL/scrypt source; **never uploaded/tested**; cannot host the worker. |

## 2. Recommended production infrastructure

**One Linux VPS running Docker Compose** (the repo already has Dockerfiles and compose):

```
Internet ─ DNS (stable domain, e.g. socialith.co) ─ Caddy/nginx (TLS, 80/443)
                    ├─ /            → web (Next.js standalone)
                    └─ /api, /media → api (Express)
        internal network: api, worker, redis, postgres
        external services: Cloudflare R2 (media), Upload-Post (publishing), transactional email, AI provider
```

- **Why a VPS, not shared cPanel:** the product needs a persistent BullMQ worker, Redis, and FFmpeg
  (Content Format Engine) — none are viable on shared hosting (verified earlier in the project: no Docker, no persistent
  background workers, no usable compiler, GLIBC 2.28, no Postgres).
- **Sizing (starting point, to be load-tested):** 2–4 vCPU, 8 GB RAM, 80+ GB SSD. FFmpeg renders are the
  CPU/disk driver; media lives in R2, not on the VPS disk.
- **Database: MySQL 8.4 LTS** (owner decision 2026-11-19; verified on 8.0.46 and 8.4.13 by the real integration suite —
  see `DATABASE_MYSQL.md`). Container on the internal network only, utf8mb4/utf8mb4_unicode_ci, strict `sql_mode`,
  separate migration (DDL) and runtime (DML) users, nightly logical dump to R2 plus a restore drill; binlog/PITR decided in Phase 1.
- **Redis:** container with AOF persistence (queues + sessions + rate limits).
- **Media:** Cloudflare R2 with signed URLs; local disk only for transient render scratch.
- **Webhooks:** Upload-Post needs a public HTTPS endpoint → requires the stable domain.
- **Secrets:** host-level env file (600) or Docker secrets; never in images or the repo; rotation runbook.
- **Observability:** structured pino logs shipped to a log service, `/api/health` + worker `/health`
  uptime checks, error tracking (Sentry var exists), queue-depth and publish-failure alerts.

### Shared cPanel hosting
**No longer a production target** (owner decision 2026-11-19). The cPanel ZIPs built earlier are superseded and contain
a BOM defect in the migration files; they are not maintained. Do not use them.

### Procurement and DNS
Nothing is purchased and no DNS record is changed by this project's tooling. Buying the VPS and creating DNS records are
owner actions (see `SOURCE_CONTROL_AND_INFRA_CHECKLIST.md` §I).

> **Implemented in Phase 1:** `infra/vps/` (compose, Caddyfile, MySQL init, Redis config, backup/restore/smoke scripts,
> `.env.example`). Procedure: `VPS_DEPLOYMENT.md`; operations: `OPERATIONS_RUNBOOK.md`. Verified locally, **not deployed**.

## 3. Environment matrix (names only)

| Concern | Variables |
|---|---|
| Core | `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` |
| URLs (**api AND worker AND web build**) | `NEXT_PUBLIC_APP_URL`, `API_PUBLIC_URL`, `NEXT_PUBLIC_API_URL` (empty = same-origin) |
| Storage | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` |
| Providers | `UPLOAD_POST_*` (see UPLOAD_POST_INTEGRATION §12); native: `TIKTOK_*`, `META_*`, `GOOGLE_*` (dormant until needed) |
| AI / email | `AI_PROVIDER_*`; email provider vars (to be added, TD-06) |
| Ops | `SENTRY_DSN`, `FFMPEG_PATH=ffmpeg` (worker only) |

Rule that would have prevented the current outage: **every service that calls `loadEnv()` receives the same
URL variables**; add a compose-level check and a boot-time structured error naming the offending variable.

## 4. Restoring the worker — OUTCOME (Phase 1)

The legacy worker was **not** repaired: the owner's instruction was to leave the legacy PostgreSQL stack untouched until a
verified replacement exists. Instead the root cause was fixed in the canonical stack (one shared URL set + a config that
refuses to boot without it) and the worker was brought up healthy in the new MySQL/VPS compose, where it was exercised
end to end (`VPS_DEPLOYMENT.md` §7). The text below is the original plan for the legacy stack, kept for reference only.

### 4a. Original plan for the legacy stack (superseded, not executed)

Goal: bring the worker up without touching data or the healthy services.

1. **Pre-flight (read-only).** Redis queues are empty and there are no `content-scheduling` delayed jobs, so
   starting consumers cannot fire anything by accident. The 5 seeded targets (SCHEDULED, 58 days overdue,
   fake tokens) have **no job** and will *not* be processed; leave them alone, they are seed data. Optionally take a `pg_dump`
   of the (seed-only) database first.
2. **Config-only fix.** In `docker-compose.tunnel.yml` add a `worker.environment` block mirroring `api`'s
   (`NEXT_PUBLIC_APP_URL` and `API_PUBLIC_URL` = `${TUNNEL_URL}`). No image rebuild, no code change.
3. **Recreate only the worker:** `docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml
   --env-file .env --env-file .env.tunnel up -d worker`. `api`, `web`, `postgres`, `redis` are untouched.
4. **Verify:** container reaches healthy; logs show all 10 workers "ready"; enqueue the harmless `cleanup`
   smoke job and confirm it is processed; confirm no unexpected job ran.
5. **Rollback:** `docker compose … stop worker` — jobs stay in Redis; nothing is lost.
6. **Known caveat:** while the quick tunnel is used, `api` and `worker` must be updated together every time the
   URL changes (until a stable domain exists, which also removes the nginx stale-IP restart dance).

Do **not** rebuild images from the repo tree or point the stack at the MySQL schema as part of this fix — that
is Phase 0's engine decision and must not be mixed with an outage repair.

## 5. Target rollout sequence

1. Git baseline (done, tag `baseline-gen2`) → engine decided: MySQL (done) → write `docker-compose.vps.yml`, MySQL-based CI and Dockerfiles (Phase 1).
2. Provision VPS, firewall (22/80/443), non-root deploy user, Docker, Caddy/nginx with TLS on the stable domain
   (DNS is an owner action; nothing in the repo or any automation modifies DNS).
3. Create secrets, rotate TikTok secret, set R2, email provider.
4. `docker compose up -d` data services → run baseline migration → seed **only** a bootstrap owner (not the dev
   seed password) → start api/worker/web.
5. Smoke: `/api/health`, login, create profile via Upload-Post sandbox, publish one test video, webhook round-trip.
6. Enable backups, alerts, log shipping. Document the runbook.
7. Only then register OAuth redirect URIs for any native provider that is still wanted.

## 6. Rollback & safety

- Images are tagged per release; database migrations are additive and reversible where possible; backups
  verified by a periodic restore test; feature flags gate new modules (Upload-Post provider, scheduling hand-off).
- Two code generations must never share one database volume.
