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
| 5 | **Rotate the TikTok client secret** — it was pasted into chat earlier and must be treated as compromised (TD-07). Procedure: `SECURITY_CREDENTIAL_ROTATION.md`. |
| 6 | Run the one-time owner bootstrap (§4a) with a password you generate in your password manager. |

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

**Never run the development seed (`prisma/seed.ts`) in production** — it creates demo accounts and a public dev
password. The first account is created with the dedicated owner-bootstrap command below.

### 4a. First owner (one time)

`apps/api/src/cli/bootstrap-owner.ts` creates the organization and its first `OWNER` — and nothing else (no demo
accounts, no sample data). It runs inside the API image, with the same configuration and the same least-privilege
database account (`socialith_app`, DML only) as the running API, and hashes the password with the same scrypt code
as every normal login.

**Safety properties** (each one is covered by automated tests, see §7):

| Property | How |
|---|---|
| Production only | refuses unless `NODE_ENV=production`, the whole configuration validates, and `NEXT_PUBLIC_APP_URL` is `https` |
| Right deployment | you must pass `--confirm-domain <your domain>`; a mismatch is refused before anything is read or written |
| No second owner | refuses (exit 3) if **any** user already exists, or if the dev seed data is present |
| Safe to re-run | the identical owner already existing → exit 0 "already initialized", nothing changed, **password not modified** |
| No race | the check-and-insert is one SERIALIZABLE transaction: of 8 simultaneous runs exactly one wins (10 rounds on MySQL 8.0 and 8.4) |
| Password never on argv/env | `--password` is rejected; use the hidden prompt, `--password-stdin` or `--password-file` |
| Password never logged | not printed, not in the audit row (`OWNER_BOOTSTRAPPED`), not in error messages |

**Procedure** — after §4 is up and `ps` shows everything `(healthy)`:

```bash
cd /opt/socialith
COMPOSE="docker compose -f infra/vps/docker-compose.yml --env-file infra/vps/.env"

# Option 1 (recommended): hidden interactive prompt, typed twice, never echoed, never in shell history
$COMPOSE run --rm api node apps/api/dist/cli/bootstrap-owner.js \
    --email you@yourcompany.com --name "Your Name" --organization "Your Company" \
    --confirm-domain YOUR_DOMAIN
```

Use a **real mailbox you control** (reserved domains such as `example.com`, `.local`, `.test` are refused). The
password must be at least 12 characters, must not contain the e-mail's local part, and must not be a known weak or
development password. Use a password-manager-generated value.

Non-interactive alternatives (still never argv/env):

```bash
# Option 2: standard input — `read -s` keeps the value out of history and out of `ps`
read -rs OWNER_PW; printf '%s' "$OWNER_PW" | $COMPOSE run --rm -T api node apps/api/dist/cli/bootstrap-owner.js \
    --email you@yourcompany.com --name "Your Name" --organization "Your Company" \
    --confirm-domain YOUR_DOMAIN --password-stdin; unset OWNER_PW

# Option 3: a file you delete afterwards (BOM / CRLF from Windows editors are tolerated)
umask 077; printf '%s' 'the-password' > /root/owner-pw          # or create it with your editor
$COMPOSE run --rm -v /root/owner-pw:/run/owner-pw:ro api node apps/api/dist/cli/bootstrap-owner.js \
    --email you@yourcompany.com --name "Your Name" --organization "Your Company" \
    --confirm-domain YOUR_DOMAIN --password-file /run/owner-pw
shred -u /root/owner-pw
```

**Expected result:** `Owner created: you@yourcompany.com` and exit code 0. Then sign in at `https://YOUR_DOMAIN/login`.

| Exit code | Meaning | What to do |
|---|---|---|
| 0 | created, or identical owner already existed | nothing |
| 2 | refused before touching the database (not production, bad config, wrong `--confirm-domain`, invalid e-mail/password, no password source) | read the message; fix and re-run |
| 3 | refused because of database state (`NOT_EMPTY`, `SEED_DATA_PRESENT`, `SLUG_TAKEN`, `SCHEMA_NOT_READY`) | `NOT_EMPTY`: an owner already exists — add people by invitation from the app. `SEED_DATA_PRESENT`: the dev seed was run against this database; start from an empty one (restore a clean backup or recreate the volume **only if you are sure it holds nothing you need**). `SCHEMA_NOT_READY`: run the migrations (`$COMPOSE up migrate`). |
| 1 | unexpected failure (database unreachable, …) — the message is deliberately terse | `$COMPOSE ps`, `$COMPOSE logs mysql api`; nothing was committed |

Afterwards: delete any password file, `unset` any shell variable that held it, and (if the password ever touched a
terminal you do not trust) change it from the app. Losing access before other users exist is recovered only by
restoring a backup or by a database administrator resetting the hash — keep the credential in a password manager.

*Windows note:* Windows PowerShell 5.1 prepends a UTF-8 BOM when piping text to a program. The command strips one
leading BOM and one trailing newline from stdin/file input, so the stored password equals what you type at the
login form (this was found and fixed during the real-stack drill — without it the owner could not have logged in).

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
| **Owner bootstrap (Phase 1 hardening)** in the real api image against MySQL 8.4 with the DML-only app account: wrong `--confirm-domain` refused (exit 2); create via stdin, hidden pseudo-terminal prompt (typed password not echoed) and BOM+CRLF password file all work (exit 0); identical re-run → "already initialized" (exit 0, password untouched); a different owner → `NOT_EMPTY` (exit 3); the created owner logs in through the real production-mode API (HTTP 200, role OWNER), a wrong password and the dev-seed credentials get 401 | yes |
| Owner bootstrap races (real MySQL 8.0.46 and 8.4.13): 10 rounds × 8 simultaneous runs, repeated twice | exactly one owner every time (an earlier GET_LOCK design produced **two** owners and was replaced by a SERIALIZABLE transaction) |

**Not verified — be honest about these before trusting it with production**
- Real Let's Encrypt issuance, DNS, and reachability of 80/443 from the internet (tested with Caddy's internal CA).
- Behaviour under load / at 225 provider profiles; heavy FFmpeg rendering (only a 1-frame extraction was run).
- Off-site backup upload (not implemented), backup/restore timings on a large database, binlog point-in-time recovery.
- Any real platform publish, OAuth callback, e-mail delivery, R2 storage or AI call (none are configured).
- The legacy worker was **not** repaired (instructed to leave the legacy stack untouched); the fix is the shared URL set above.
