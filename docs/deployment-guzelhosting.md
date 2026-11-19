# Production deployment — socialith.co (Güzel Hosting)

Status as of this writing: **blocked on SSH access**. `socialith.co` →
`89.252.180.99` is a real, live Güzel Hosting cPanel server (cPanel
`2083` and WHM `2087` both respond over HTTPS), but SSH does not answer
on port `22`, `2222`, `22222`, or `21098` from here. Nothing below has
been executed against the server yet — this is the full plan to execute
the moment SSH access is confirmed, so there's no lost time waiting on
the hosting provider.

## 1. Real capacity check (do this first, before anything else)

Do **not** assume the target is capable — verify for real over SSH,
then decide:

```bash
# OS / kernel
cat /etc/os-release; uname -a

# Resources
nproc; free -h; df -h

# Docker
docker --version; docker compose version; systemctl status docker 2>&1 | head -5

# Whether this account actually has root / can install packages
whoami; id; sudo -n true 2>&1 && echo "passwordless sudo OK" || echo "no sudo"

# Existing web server owning ports 80/443 (cPanel almost always runs
# Apache or LiteSpeed here — matters for the reverse-proxy plan below)
sudo ss -tlnp | grep -E ':80|:443' 2>&1 || ss -tlnp | grep -E ':80|:443'

# Node/Postgres/Redis/ffmpeg, if present outside Docker
node -v 2>&1; psql --version 2>&1; redis-server --version 2>&1; ffmpeg -version 2>&1 | head -1
```

**Decision point**: standard shared cPanel hosting (CloudLinux + cPanel,
no root, no Docker daemon, Apache/LiteSpeed owning 80/443 via cPAddons)
cannot run this stack — Postgres, Redis, and a persistent worker process
are the specific blockers (shared hosting deliberately disallows
long-running background daemons and arbitrary listening ports). If the
check above confirms that's the situation here, **stop and report
back** — don't force it (per explicit instruction) — the real fix is a
Güzel Hosting VPS/Cloud Server product (KVM VPS with root access),
keeping the same `socialith.co` domain/DNS, just pointed at the new
server's IP once it exists. If Docker + root genuinely are available
(some "Cloud"-tier cPanel products do bundle a KVM guest with root),
proceed with section 2.

## 2. Target architecture

Single domain, path-based reverse proxy — this matches the TikTok
callback you specified (`https://socialith.co/api/oauth/tiktok/callback`,
same domain, not a subdomain):

```
Internet ─▶ Nginx (host, :80/:443, Let's Encrypt) ─┬─▶ /api/*, /media/*  ─▶ 127.0.0.1:4000  (api container)
                                                     └─▶ everything else  ─▶ 127.0.0.1:3000  (web container)
worker container: no exposed port, talks to postgres/redis containers only
postgres/redis containers: no exposed host port (internal compose network only)
```

This is exactly what `docker-compose.prod.yml` already builds
(`apps/{api,worker,web}/Dockerfile`) — the only new piece needed on a
fresh VPS is the host-level Nginx + TLS cert, since `docker-compose.prod.yml`
intentionally does not include its own reverse-proxy/TLS container (see
below for why that's the right call here rather than adding one).

`NEXT_PUBLIC_API_URL=https://socialith.co` makes the web app's own
`fetch` calls go to `https://socialith.co/api/...` — **same-origin** as
the page itself, so there's no CORS preflight for the browser to worry
about at all; `apps/api/src/app.ts`'s CORS check still passes regardless
since `NEXT_PUBLIC_APP_URL` will equal the request's real `Origin`.

## 3. Provisioning steps (once SSH + Docker/root are confirmed)

```bash
# 1. Docker + Compose plugin (Ubuntu/Debian — adjust if the VPS image differs)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $(whoami)

# 2. Nginx + Certbot (host-level, terminates TLS, proxies to the containers)
sudo apt-get update && sudo apt-get install -y nginx certbot python3-certbot-nginx

# 3. Clone the repo (never commit the real .env — see step 4)
git clone <this repo's real remote> /opt/socialith
cd /opt/socialith

# 4. Real production .env — see the full variable table in section 4.
#    Created directly on the server, never committed, never pasted into
#    chat/logs. `chmod 600 .env`.
nano .env

# 5. Bring the real stack up (NOT the local-test overlay — that overlay
#    exists only to bypass the localhost-origin guard for local testing
#    and must never be used here)
docker compose -f docker-compose.prod.yml --env-file .env up -d --build

# 6. Apply migrations + seed the real production owner account
docker compose -f docker-compose.prod.yml --env-file .env exec api \
  sh -c "cd packages/database && node_modules/.bin/prisma migrate deploy"
# Seeding: do NOT run prisma/seed.ts as-is in production — it creates a
# dev-only owner with a publicly-known password
# ("change-me-in-dev", visible in this repo's source). Either create the
# real owner through a one-off script with a real generated password, or
# temporarily adapt the seed to prompt for one — never leave the dev
# password reachable on a real deployment.
```

Nginx site config (`/etc/nginx/sites-available/socialith.co`):

```nginx
server {
    listen 80;
    server_name socialith.co www.socialith.co;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name socialith.co www.socialith.co;
    # ssl_certificate / ssl_certificate_key: filled in by certbot --nginx

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /media/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/socialith.co /etc/nginx/sites-enabled/
sudo certbot --nginx -d socialith.co -d www.socialith.co
sudo systemctl reload nginx
```

Because Nginx forwards `X-Forwarded-Proto`/`X-Forwarded-For` and the API
runs with `NODE_ENV=production`, `apps/api/src/app.ts`'s existing
`app.set("trust proxy", 1)` (already in the code, one hop) is the
correct setting for exactly this one-Nginx-hop topology — no code change
needed there.

## 4. Required production environment variables

Real values only — never the local-test ones from this repo's dev
`.env`. Generate fresh secrets on the server itself.

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `NEXT_PUBLIC_APP_URL` | `https://socialith.co` |
| `NEXT_PUBLIC_API_URL` | `https://socialith.co` |
| `API_PUBLIC_URL` | `https://socialith.co` |
| `API_PORT` | `4000` |
| `WORKER_PORT` | `4100` |
| `DATABASE_URL` | `postgresql://socialith:<real password>@postgres:5432/socialith?schema=public` (container-network hostname, same pattern as `docker-compose.prod.yml`'s override) |
| `REDIS_URL` | `redis://redis:6379` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | real values — `openssl rand -base64 32` for the password |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `TOKEN_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — exactly 64 hex chars |
| `EMAIL_PROVIDER` | `console` until a real provider is wired in (Phase-11-scoped, out of this pass) |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | the real values already confirmed working in this session |
| `TIKTOK_REDIRECT_URI` | leave unset — computed default is already `https://socialith.co/api/oauth/tiktok/callback` once `API_PUBLIC_URL` is set correctly |
| `META_APP_ID` / `META_APP_SECRET` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | leave blank unless/until those platforms are also configured — code already handles missing credentials as a real `CONFIGURATION_ERROR`, never a fake success |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_PUBLIC_URL` | recommended for real production (see `docs/setup-r2.md`) — without them, uploaded media falls back to local disk inside the API container, which does **not** survive a redeploy and isn't shared across containers; fine for the App Review demo, not for real ongoing use |
| `AI_PROVIDER_API_KEY` etc. | optional, same CONFIGURATION_ERROR-safe fallback |
| `FFMPEG_PATH` | `ffmpeg` (already installed via apt in `apps/worker/Dockerfile`'s runtime stage — never a host path) |

## 5. TikTok Developer Portal

- Web/Desktop URL: `https://socialith.co`
- Redirect URI (Login Kit): `https://socialith.co/api/oauth/tiktok/callback`
- Terms of Service: `https://socialith.co/terms`
- Privacy Policy: `https://socialith.co/privacy`
- Scopes: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`, `video.upload`

## 6. DNS

`socialith.co`'s `A`/`AAAA` records currently point at the existing
shared-hosting IP (`89.252.180.99`). **Not changed by anything above** —
per instruction, this repo/session does not touch DNS. If the capacity
check in section 1 concludes a VPS/Cloud Server is required, the only
DNS change needed later is repointing the `A` record (and `AAAA` if
used) to the new server's IP once it's provisioned and the stack is
verified working there — done deliberately, by you, not as a side effect
of anything automated here.

## 7. Post-deploy real E2E checklist

Run for real once the stack is up, in this order:

1. `curl -I https://socialith.co` → `200`, valid cert.
2. `curl https://socialith.co/api/health` → `{"success":true,"data":{"status":"ok",...}}`, `checks.database`/`checks.redis` both `true`, real `queues` array.
3. `docker compose -f docker-compose.prod.yml --env-file .env logs worker --tail 20` → all 10 queues report "ready and connected to Redis", no crash-loop.
4. Browser: `https://socialith.co/login` → real login with the real seeded/created owner account.
5. Dashboard renders with real (zeroed, fresh-DB) counts.
6. `/accounts` → **Connect TikTok** → verify the redirect actually lands on `https://www.tiktok.com/v2/auth/authorize/...` with `client_key` matching the real `TIKTOK_CLIENT_KEY` and a `redirect_uri` of exactly `https://socialith.co/api/oauth/tiktok/callback`.
7. `/terms` and `/privacy` render.
8. `/content` → create/open content, upload a real video asset, verify it's reachable at its real URL (either the local `/media/...` route through Nginx, or the real R2 URL if configured).
