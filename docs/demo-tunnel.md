# Local Cloudflare Tunnel demo

Runs the real production Docker images (same `docker-compose.prod.yml` used for
the eventual Güzel Hosting deployment) on this machine and exposes them over a
temporary, random `*.trycloudflare.com` HTTPS URL — no VPS, no DNS change, no
effect on the real `socialith.co` domain.

## Topology

A single Nginx container (`nginx.tunnel.conf`) is the only thing `cloudflared`
forwards to. It does the same single-domain, path-based routing documented for
real production in [deployment-guzelhosting.md](./deployment-guzelhosting.md):

- `/api/*`, `/media/*`, `/health` → `api:4000`
- everything else → `web:3000`

`api`/`web` no longer publish host ports directly (`docker-compose.tunnel.yml`
resets them) — only `nginx` does, on `8080`, matching the real prod topology's
single entry point. The Next.js web build's `NEXT_PUBLIC_API_URL` build arg is
forced empty for this overlay (overriding whatever `.env` has for plain
`pnpm dev` use) so the browser calls the tunnel's own origin — see
`apps/web/src/lib/api.ts`'s same-origin fallback.

## Run it

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --env-file .env up -d --build
```

Read the assigned URL from `cloudflared`'s logs:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml logs cloudflared | Select-String trycloudflare
```

Write it to `.env.tunnel` (gitignored):

```
TUNNEL_URL=https://<assigned>.trycloudflare.com
```

Recreate just the `api` container so it picks up the real public URL for
`NEXT_PUBLIC_APP_URL`/`API_PUBLIC_URL` (no rebuild needed):

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --env-file .env --env-file .env.tunnel up -d api
```

Apply migrations / seed demo data if this is a fresh volume:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --env-file .env exec api npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --env-file .env exec api node packages/database/prisma/seed.js
```

## Caveats

- **The URL is ephemeral.** A quick Cloudflare Tunnel has no fixed hostname —
  stopping/restarting the `cloudflared` container assigns a brand new random
  URL. Repeat the "read the URL → write `.env.tunnel` → recreate `api`" steps
  above whenever that happens.
- **TikTok's redirect_uri must be registered in the TikTok Developer Portal**
  for the OAuth callback to actually complete. Since this URL changes every
  run, add `https://<current-tunnel>.trycloudflare.com/api/oauth/tiktok/callback`
  to the app's Web redirect URIs before testing login end-to-end; otherwise
  TikTok will reject the request as an unregistered redirect_uri.
- Stop everything with:
  ```bash
  docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml down
  ```
  (add `-v` only if you also want to wipe the Postgres/Redis/media volumes).
