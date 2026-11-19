# Socialith — VPS deployment (Docker Compose)

Status: **prepared and verified locally; not deployed.** No server was bought, no DNS record
changed, nothing runs in production. Everything here lives in `infra/vps/`. Operations
(backups, restore, monitoring, incidents) are in `OPERATIONS_RUNBOOK.md`.

## 1. Topology

```
Internet ─ 80/443 ─ Caddy (automatic HTTPS, Let's Encrypt)
                     ├─ /api/*, /media/*  →  api   :4000
                     └─ everything else   →  web   :3000
 backend network (no ports published to the host):
     mysql 8.4 · redis 7 (AOF, password, noeviction) · api · worker (BullMQ + FFmpeg)
 one-shot:  migrate (prisma migrate deploy, DDL account) — api and worker wait for it
```

- One domain, one URL set: `APP_DOMAIN` becomes `NEXT_PUBLIC_APP_URL` **and** `API_PUBLIC_URL` for every
  service that loads the config (api, worker, migrate). The legacy worker crash loop came from the worker
  not receiving the URLs the API had; the config now also *refuses to boot* (one structured log line naming
  each variable) if either URL is missing or points at localhost in production.
- Least-privilege MySQL accounts: **app** (SELECT/INSERT/UPDATE/DELETE — api, worker), **migrate** (DDL — only
  the one-shot migrate service and restores), **backup** (read + lock). Verified: the app account cannot
  `DROP`/`CREATE`/`ALTER`.
- Only Caddy publishes ports (80/443). MySQL, Redis, api, worker and web are reachable only inside the
  compose network.
- Sized for 4 vCPU / 8 GB: `mem_limit`s are mysql 2 g, worker 2 g, api 1 g, web 1 g, redis 512 m, caddy 256 m;
  MySQL buffer pool 1 GiB. A starting point, **not load-tested**.

## 2. What you must do yourself (nothing here is done or purchased by the project)

| # | Owner action |
|---|---|
| 1 | Choose a provider and buy the VPS (Ubuntu LTS, 4 vCPU / 8 GB / ≥ 80 GB SSD). |
| 2 | Pick the production domain and create its **A/AAAA record → the VPS IP** at your DNS provider. Caddy cannot get a certificate until that resolves. |
| 3 | Open inbound 22, 80, 443 only (provider firewall and/or `ufw`). |
| 4 | Create a Cloudflare R2 bucket + API keys (media; recommended over the local volume) and a transactional e-mail account when those phases need them. |
| 5 | Rotate the TikTok client secret that was pasted into chat earlier (TD-07) before it is used anywhere. |

## 3. Provision the server (outline)

```bash
adduser deploy && usermod -aG sudo deploy          # non-root operator; add your SSH key, disable password + root SSH login
apt update && apt -y upgrade && apt -y install ufw fail2ban unattended-upgrades git
ufw default deny incoming && ufw allow 22,80,443/tcp && ufw allow 443/udp && ufw enable
curl -fsSL https://get.docker.com | sh && usermod -aG docker deploy     # Docker Engine + Compose plugin
```

## 4. First deployment

```bash
git clone https://github.com/gunay96/socialith.git /opt/socialith && cd /opt/socialith
git checkout <the tag you approved>                     # never deploy an untagged branch tip
cp infra/vps/.env.example infra/vps/.env && chmod 600 infra/vps/.env
```
Fill every value in `infra/vps/.env` (hex secrets: `openssl rand -hex 24` for passwords,
`openssl rand -hex 32` for `SESSION_SECRET`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`). Compose refuses to start
if any required value is missing. Then:

```bash
docker compose -f infra/vps/docker-compose.yml --env-file infra/vps/.env up -d --build
docker compose -f infra/vps/docker-compose.yml --env-file infra/vps/.env ps          # all (healthy)
sh infra/vps/scripts/smoke-test.sh https://YOUR_DOMAIN                               # expect ALL CHECKS PASSED
```
Back up `infra/vps/.env` and especially `TOKEN_ENCRYPTION_KEY` **separately from the database** (losing the key
makes every stored OAuth token unreadable).

> **Open blocker for real use — first user.** The app is invite-only and the only way to create the first OWNER
> today is `packages/database/prisma/seed.ts`, which also creates demo accounts and a **known dev password**
> (`change-me-in-dev`). **Never run the seed in production.** A safe one-off "create owner" command does not
> exist yet and is not part of Phase 1; it must be added (with your approval) before anyone can log in on a real deployment.

## 5. Updating and rolling back

```bash
git fetch --tags && git checkout <new-approved-tag>
docker compose … up -d --build        # migrate runs first; api/worker restart only after it succeeds
sh infra/vps/scripts/smoke-test.sh https://YOUR_DOMAIN
```
Rollback: `git checkout <previous tag>` and `up -d --build` again. Migrations are additive by policy, so the
previous code runs on the newer schema; if a release ever ships a destructive migration, restore the pre-release
backup instead (`OPERATIONS_RUNBOOK.md` §Restore). **Always take a backup immediately before updating.**

## 6. Local verification (how this was tested — no domain, no certificate)

A separate compose project (`-p socialith-p1`: own containers, network, volumes) with an overlay that remaps Caddy to
`127.0.0.1:18443` and uses Caddy's internal CA. It cannot touch the legacy PostgreSQL stack.

```bash
# throwaway env: random hex, never reused for a real deployment
cp infra/vps/.env.example /tmp/p1.env     # fill with random hex; APP_DOMAIN=app.socialith.test, BACKUP_DIR=/tmp/p1-backups
docker compose -p socialith-p1 -f infra/vps/docker-compose.yml -f infra/vps/docker-compose.local-verify.yml --env-file /tmp/p1.env up -d --build
CURL_OPTS="-k --resolve app.socialith.test:18443:127.0.0.1" sh infra/vps/scripts/smoke-test.sh https://app.socialith.test:18443
docker compose -p socialith-p1 … down -v      # remove it (and its throwaway volumes)
```

## 7. What was verified, and what was not

**Verified (2026-11-19, local Docker, MySQL 8.4.13, Redis 7, FFmpeg 5.1.9)**

| Check | Result |
|---|---|
| Images build from the repository | api, worker, web: 2.7 min cold |
| Stack boots: mysql → migrate (exit 0) → redis → api/worker → web → caddy, all healthy | yes — **including the worker (all 11 BullMQ workers ready)** |
| Smoke test through Caddy over HTTPS (health, login page, routing, HSTS, no Server banner, auth wall, container health) | 13/13 |
| Login → Redis-backed session → `/auth/me` through the proxy | works |
| Seed runs as the DML-only account; every demo account tagged `seed: true` | yes |
| Real chain API → Redis → worker → MySQL on a demo account | target FAILED `CONFIGURATION_ERROR`, immutable attempt row, **no platform call** |
| DB-only SCHEDULED rows (no BullMQ job): future one fires 38 ms after its time; 58-day-overdue one is held, 0 publish attempts, audit row | yes |
| Total Redis wipe while running | schedule re-registered and the lost delayed job re-created in 10 s, no restart |
| Worker stopped, then work queued/overdue, then started | publish-now, due and stale rows all resolved correctly 4 s after start; graceful stop 0.7 s, exit 0 |
| Redis AOF survives a container restart (key + delayed jobs) | yes |
| MySQL settings really in force (found *not* to be, with a mounted .cnf; now command args) | 1 GiB pool, unicode_ci, 7-day binlog, slow log |
| App account cannot DROP/CREATE/ALTER; DB/Redis/api/web/worker ports not published | yes |
| Backup → checksum → restore drill into a scratch DB → counts identical; tampered backup refused; unconfirmed live overwrite refused; real restore returns exactly to the backup point | yes |
| Bad production env (localhost URL, no `API_PUBLIC_URL`) on the real worker and api images | one structured fatal line naming both variables, exit 1 |
| FFmpeg inside the worker | extracts a real JPEG frame |

**Not verified — be honest about these before trusting it with production**
- Real Let's Encrypt issuance, DNS, and reachability of 80/443 from the internet (tested with Caddy's internal CA).
- Behaviour under load / at 225 provider profiles; heavy FFmpeg rendering (only a 1-frame extraction was run).
- Off-site backup upload (not implemented), backup/restore timings on a large database, binlog point-in-time recovery.
- Any real platform publish, OAuth callback, e-mail delivery, R2 storage or AI call (none are configured).
- The legacy worker was **not** repaired (instructed to leave the legacy stack untouched); the fix is the shared URL set above.
