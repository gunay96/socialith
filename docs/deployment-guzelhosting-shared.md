# Güzel Hosting shared cPanel deployment (no VPS, no Docker, no SSH, no Redis/worker)

This is the demo/production-lite deployment path: `socialith.co` on the
existing shared cPanel plan, using cPanel's **Setup Node.js App**
(Phusion Passenger) feature only. No Docker, no SSH, no persistent
BullMQ worker, no Redis required.

## What this tier does and doesn't do

**Works:** Next.js web app, Express API, PostgreSQL, Login, TikTok OAuth
connect, Instagram OAuth connect, Dashboard/Accounts/Content (read/CRUD).

**Does not work (by design, not a bug):** content generation (AI
captions), video rendering (FFmpeg), scheduled/automatic publishing,
analytics sync. These all require `apps/worker`, which isn't deployed in
this tier — see [Blocker 1 decision](#redis--worker) below. The API logs
a clear warning at boot and every affected call no-ops instead of
crashing (`apps/api/src/lib/queue.ts`).

## Prerequisites to confirm before starting

1. **PostgreSQL availability** — check cPanel's home screen for a
   "PostgreSQL Databases" icon. If absent, use an external managed
   Postgres (e.g. Neon/Supabase free tier) and just point `DATABASE_URL`
   at it — no code changes needed either way.
2. **Node.js version** — cPanel → **Setup Node.js App** → the version
   dropdown must offer **Node 20.x or newer**.
3. Outbound internet access from the app's shell context (needed once,
   to `npm install` the `prisma` CLI during first deploy) — virtually
   always allowed on shared hosting.

## Redis / worker

**Decision made: Option A — Redis removed from the code path entirely.**
`REDIS_URL` is now optional (`packages/config/src/index.ts`). Without it:
sessions fall back to in-memory (`apps/api/src/lib/session.ts`), rate
limiters fall back to in-memory (`apps/api/src/middleware/rate-limit.ts`),
and every `enqueue*` call in `apps/api/src/lib/queue.ts` logs a warning
and no-ops instead of crashing. **Do not set `REDIS_URL` in the API's
environment variables** — leave it unset entirely.

---

## Files to upload

Two ready-to-upload zip files, already built and prepared:

| Zip | Contents | Unpacks to |
|---|---|---|
| `deploy/socialith-api-deploy.zip` (~46 MB) | Compiled `apps/api` + every workspace package it needs, as real files (no `workspace:*`, no symlinks) | the API's Application Root |
| `deploy/socialith-web-deploy.zip` (~65 MB) | `apps/web` source + dependencies, ready to `next build` on the server | the Web's Application Root |

Both already have their `package.json` rewritten so plain `npm install`
works (internal `@socialith/*` packages point at their already-vendored
`file:node_modules/@socialith/...` path — no registry lookup, no
`workspace:*` error) and each has a `postinstall` script that finishes
the setup automatically once you click cPanel's **"Run NPM Install"**
button — no SSH, no browser terminal needed.

- API's `postinstall`: installs the `prisma` CLI (matches
  `@prisma/client`'s pinned `5.22.0`), then runs `prisma generate`
  (produces the correct **Linux** query engine — the one in this zip was
  built on Windows for local verification and is not used) and
  `prisma migrate deploy` against whatever `DATABASE_URL` you configure.
- Web's `postinstall`: runs `next build` (produces
  `.next/standalone/server.js`), then copies `public/` and
  `.next/static` into the standalone output — the two files Next.js's
  own tracing doesn't copy automatically.

## cPanel: create the two Node.js Apps

**Setup Node.js App → Create Application**, twice:

### App 1 — API

| Field | Value |
|---|---|
| Node.js version | 20.x (or newest available ≥ 20) |
| Application mode | Production |
| Application root | e.g. `socialith-api` (cPanel shows the full absolute path once chosen — note it, you'll need it to upload into) |
| Application URL | `socialith.co/api` |
| Application startup file | `dist/index.js` |

### App 2 — Web

| Field | Value |
|---|---|
| Node.js version | 20.x (or newest available ≥ 20) |
| Application mode | Production |
| Application root | e.g. `socialith-web` |
| Application URL | `socialith.co` (domain root) |
| Application startup file | **`.next/standalone/server.js`** — note this is a subpath *inside* the application root, only present after the `postinstall` build step has run once. If the UI won't accept a path that doesn't exist yet, save the app first with any placeholder, run "Run NPM Install" once (which creates it), then edit the app and set the real startup file path. |

Passenger-specific settings (both apps): leave defaults. cPanel injects
its own `PORT` env var into each app automatically — do not set `API_PORT`
manually.

## Upload steps (File Manager, no SSH)

For each app:
1. cPanel → **File Manager** → navigate into the Application Root folder
   cPanel created (e.g. `/home/<user>/socialith-api`).
2. **Upload** the matching zip (`socialith-api-deploy.zip` /
   `socialith-web-deploy.zip`).
3. Select the uploaded zip → **Extract** (extracts directly into this
   folder — the zips have no wrapper folder, verified).
4. Delete the zip file afterward (optional cleanup).

You're replacing the current unrelated site at `socialith.co` — no
backup needed per your instruction.

## Environment variables

Set these in cPanel's **Setup Node.js App → (each app) → Environment
Variables** section, not in any file. Real secret values are yours to
fill in — never paste them back to me in chat once set.

### API app

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | your real Postgres connection string |
| `API_PUBLIC_URL` | `https://socialith.co` |
| `NEXT_PUBLIC_APP_URL` | `https://socialith.co` |
| `SESSION_SECRET` | a real random value, 32+ chars (`openssl rand -hex 32` or any password generator) |
| `JWT_SECRET` | a real random value, 32+ chars |
| `TOKEN_ENCRYPTION_KEY` | exactly 64 hex characters (`openssl rand -hex 32`) |
| `TIKTOK_CLIENT_KEY` | your TikTok app's client key (from the Developer Portal) |
| `TIKTOK_CLIENT_SECRET` | your real secret (enter directly in cPanel's field only) |
| `TIKTOK_REDIRECT_URI` | leave unset — auto-computes to `https://socialith.co/api/oauth/tiktok/callback` |
| `META_APP_ID` | your Instagram app id |
| `META_APP_SECRET` | your real secret (cPanel field only) |
| `META_REDIRECT_URI` | leave unset — auto-computes to `https://socialith.co/api/oauth/instagram/callback` |
| `EMAIL_PROVIDER` | `console` (no real email provider configured yet — password reset/invite emails log server-side instead of sending) |
| `REDIS_URL` | **do not set** |

### Web app

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NEXT_PUBLIC_APP_URL` | `https://socialith.co` |
| `NEXT_PUBLIC_API_URL` | **leave unset/empty** — `apps/web/src/lib/api.ts` falls back to the browser's own origin, which is correct here since API and web share `socialith.co` |

## TikTok / Instagram developer portal

Register these exact redirect URIs (replacing whatever was there before):
- TikTok Login Kit: `https://socialith.co/api/oauth/tiktok/callback`
- Instagram (Meta) app: `https://socialith.co/api/oauth/instagram/callback`

## First-deploy order

1. Create both Node.js Apps in cPanel (above).
2. Upload + extract both zips into their Application Roots.
3. Set both apps' environment variables.
4. API app → click **Run NPM Install**. Watch the log: it should show
   `prisma generate` finding the Linux engine and `migrate deploy`
   applying migrations against your real `DATABASE_URL`.
5. Web app → click **Run NPM Install**. Watch the log for `next build`
   completing and the `public`/`.next/static` copy step. This can take a
   few minutes.
6. Web app → edit the app, set **Application startup file** to
   `.next/standalone/server.js` (now that it exists — see the table
   above), save.
7. Restart both apps (cPanel's "Restart" button on each).
8. Verify: `https://socialith.co/api/health` → `{"success":true,...}`;
   `https://socialith.co` loads the login page; log in; check
   Dashboard/Accounts/Content render; click "Connect TikTok" and confirm
   it redirects to TikTok's real authorize page with the right
   `redirect_uri`.

## Redeploying after a code change

Re-zip the updated `deploy/api` or `deploy/web` folder (regenerate via
`pnpm --filter @socialith/api deploy --prod ./deploy/api` /
`pnpm --filter @socialith/web deploy --prod ./deploy/web` from this
repo), re-upload + extract over the existing folder, click **Run NPM
Install** again, restart the app.
