# Upload-Post — setup (owner guide)

What you must do yourself, in order. Nothing here is done by the project's tooling, and **no credential ever goes through chat, Git, an image, or the browser**: the API key lives only in the server's environment file.

## 0. Before you start

- An Upload-Post account on a plan that includes the platforms you need (TikTok publishing, for example, depends on the plan — the provider answers 403 otherwise). The number of profiles your plan allows (225 on Business, per your information) is read from the provider at every sync; it is not configured anywhere in Socialith.
- Socialith deployed (`VPS_DEPLOYMENT.md`) or running locally, with the database migrated (the Phase 2 migrations are additive) and the owner bootstrapped.
- Recommended before any real publication: a **dedicated test profile** with a throwaway social account.

## 1. Create the API key (in Upload-Post)

In your Upload-Post dashboard create an API key (menu names change; look for *API keys* / *Settings*). Copy it **straight into your password manager**. Do not paste it into a chat, a ticket, a commit or a terminal history.

## 2. Put it in the server environment

Edit the environment file yourself, on the machine that runs Socialith:

- VPS: `infra/vps/.env` (permissions `600`, git-ignored). Local development: the git-ignored `.env` at the repository root.

```
UPLOAD_POST_API_KEY=<your key>            # required; server-side only
UPLOAD_POST_WEBHOOK_SECRET=               # optional, see step 5
UPLOAD_POST_ORGANIZATION_ID=              # only if this deployment has more than one organization
UPLOAD_POST_SYNC_INTERVAL_MINUTES=30
UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED=false   # leave false until step 8
```

Then recreate the services that read it:

```bash
docker compose -f infra/vps/docker-compose.yml --env-file infra/vps/.env up -d api worker
```

Configuration rules enforced at boot: `UPLOAD_POST_BASE_URL` (normally unset = the provider's production API) must be `https` in production; an implausibly short key or secret refuses to boot with a message naming the variable, never its value.
If the key is unset, everything keeps working — the dashboard says "not configured" and publishing through Upload-Post fails with a clear message; nothing is ever faked.

## 3. First live check — read-only

On a machine where the key is configured:

```powershell
node scripts/upload-post-live-check.mjs
```

It performs exactly two GET requests (`/uploadposts/me`, `/uploadposts/users`), prints a redacted summary (plan, profile limit reported by the provider, accounts per platform, accounts needing reauthorization) and publishes nothing. Record the result in `UPLOAD_POST_TESTING.md` §4. If it fails, see §9.

## 4. Connect social accounts (in Upload-Post)

Profiles and their social accounts are created and connected in Upload-Post (its dashboard / connect links). In Phase 2 Socialith **reads** them; it does not create profiles or run the platforms' OAuth for Upload-Post accounts. Each profile holds at most one account per platform.

On a trial/free-level plan (e.g. plan `Default`, 2 profiles) you can start with **Instagram and/or YouTube**: connect them in Upload-Post, then **Overview → Sync now**. The **Platform availability** card (Overview and Plan & usage) shows what the provider has actually confirmed; **TikTok stays UNAVAILABLE until Upload-Post returns a TikTok account**, and nothing in Socialith simulates a connection. Which platforms your plan may connect is decided by Upload-Post, not by Socialith — if a connection is refused there, that is the plan, and the card keeps saying "not confirmed". No plan purchase or upgrade is needed or performed by Socialith.

## 5. Webhooks (optional but recommended)

Webhooks make results appear in seconds instead of on the next poll/sweep. Without them everything still reconciles by polling.

1. In Upload-Post (notifications / webhooks) set the URL to `https://YOUR_DOMAIN/api/webhooks/upload-post` and enable `upload_completed` and the `social_account_*` events.
2. Upload-Post shows a **signing secret** once a URL is saved. Copy it into `UPLOAD_POST_WEBHOOK_SECRET` in the server environment (same care as the key) and recreate `api`.
3. **Rotation:** put the new secret in `UPLOAD_POST_WEBHOOK_SECRET`, move the old one to `UPLOAD_POST_WEBHOOK_SECRET_PREVIOUS`, recreate `api`, rotate in Upload-Post, and clear `…_PREVIOUS` a few minutes later. Both are accepted meanwhile.
4. Check: Upload-Post's "test notification" should be answered `200`; a request with a wrong signature is answered `401` and queues nothing. If no secret is configured the route answers `503` and processes nothing.

## 6. Synchronize and review

Dashboard → **Upload-Post → Overview → Sync now** (Admin). Status moves `SYNC PENDING → CONNECTED`. Review **Profiles** and **Accounts**: accounts marked *REAUTH REQUIRED* must be reconnected by their owner in Upload-Post; accounts marked *shared across profiles* are the same real account in several profiles (enabling it as a destination is allowed once).

## 7. Map and enable destinations

**Mapping** page: assign each profile to a thematic page and each account to a creator (both are Socialith-side labels; synchronization never changes them). On **Accounts**, *Enable* turns a connected TikTok/Instagram/YouTube account into a **publishing destination**. Enabling is refused (with the reason) when the account needs reconnecting, when the same account is already connected natively (Socialith will not silently switch an existing native route), or when it is already a destination through another profile. *Disable* is refused while targets are still pending for it; history is always kept.

## 8. Hybrid scheduling (optional — leave off until verified)

Off by default: Socialith fires every scheduled publication itself. To let Upload-Post's scheduler run targets due within a window (default 48 h):

1. Verify on a **test destination**, with explicit approval for a real test post, that a handed-off job is created, edited when you reschedule in Socialith, cancelled when you unschedule, and published once (`UPLOAD_POST_TESTING.md` §5).
2. Use durable media URLs (local storage or R2 behind a public bucket). Presigned R2 URLs expire in about an hour, so the sweep refuses to hand such targets off.
3. Set `UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED=true`, optionally `UPLOAD_POST_SCHEDULE_HANDOFF_WINDOW_HOURS`, recreate `worker`.
Turning it off again is safe: the sweep releases provider-owned jobs back to Socialith as targets change, and a hand-off in doubt always resolves to Socialith owning the target.

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Overview: "not configured" | no `UPLOAD_POST_API_KEY` in the server env | step 2 |
| Health: `AUTH` | key rejected/expired | create a new key, replace it (step 2) |
| Overview: "belongs to a different organization" / "set UPLOAD_POST_ORGANIZATION_ID" | several organizations in the deployment | set `UPLOAD_POST_ORGANIZATION_ID` to the owning organization |
| `SYNC FAILED` | provider unreachable/erroring; see the message on Overview/Plan | usually clears at the next sync; check Health |
| `LIMIT REACHED` | profile limit of the plan used | remove profiles in Upload-Post or change plan |
| Publication `FAILED` "must be reconnected" | account authorization expired | owner reconnects it in Upload-Post; sync; retry the target |
| Publication `FAILED` "limit reached" | monthly upload / scheduled-post limit of the plan | wait for the window or change plan |
| Publication `OUTCOME UNKNOWN` | request timed out | resolved automatically (the provider is asked by `external_id`); nothing is resent blindly |
| TikTok music "not attached" | mapping not verified / rights not confirmed / account lacks `music` | Sounds → mapping, or reconnect TikTok in Upload-Post |
| Destination suddenly `ERROR` after a sync | the account behind the profile changed (identity change) | review it, then re-enable the destination |
| Webhook 401 | wrong/stale secret or clock skew > 5 min | step 5; check server time |
