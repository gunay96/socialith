# Socialith — credential rotation and secret handling

Rules that apply to everyone, including the AI assistant working on this repository:

- **Credentials never go in Git, in source code, in a compose file, in an image, or in a chat.** Real values live
  only in `infra/vps/.env` on the server (`chmod 600`) and in your password manager.
- **Nobody is ever asked to paste a credential or token into a chat.** If a task needs one, you type it yourself
  into the server's `.env` (or the provider's own portal) in your own terminal/browser.
- A secret that has been pasted anywhere it should not be (chat, ticket, screenshot, e-mail, public repo) is
  **compromised for good** — deleting the message does not un-expose it. The only fix is to **rotate** it.

## 1. INCIDENT — TikTok client secret (TD-07): treat as compromised, rotation is owner-only and still pending

The TikTok app's **client secret** was pasted into a chat during an earlier session. That session transcript is
stored outside this repository and cannot be edited, so the value must be considered known to whoever can read it.

**Where the old value was found (checked on 2026-11-19; values were never printed, only paths):**

| Location | Holds the old secret? | Action after rotation |
|---|---|---|
| Git history (all branches/tags) and the tracked tree | **No** — searched for the exact value: 0 commits, 0 files | none |
| Repository bundles and source ZIPs in `Desktop\socialith-backups\2026-11-19\` | **No** | none |
| `C:\…\socialith\.env` (git-ignored, local only) | **Yes** | replace the value (or delete the line) |
| `C:\…\socialith-backups\2026-11-19\private\.env` (private backup of the local env) | **Yes** | overwrite/delete the file, or replace the value |
| Legacy PostgreSQL stack containers `socialith-prod-api-1`, `-web-1`, `-worker-1` (environment variable) | **Yes** | stays until those containers are recreated; harmless once the old secret is invalid — the legacy stack was deliberately left untouched |
| The chat transcript of the earlier session | **Yes** | cannot be scrubbed — this is why rotation is mandatory |
| The new VPS stack (`infra/vps`) | No (its `.env` does not exist yet; `.env.example` holds an empty value) | enter the **new** secret there only |

### Procedure (you do this; the assistant cannot and must not)

1. **Regenerate the secret at the provider.** Sign in to the TikTok for Developers portal with the account that owns
   the app, open the app's credentials page and use the option to regenerate/reset the **client secret** (menu names
   change; look for *Client secret → Regenerate/Reset*). The old secret stops working when the new one is issued;
   if the portal asks you to confirm, do. The **client key** is not secret and does not change.
2. **Copy the new secret straight into your password manager.** Do not paste it into chat, a ticket, a commit, a
   command line, or a shell variable on a shared machine.
3. **Enter it where the application reads it** — only after the VPS exists (TikTok is not configured in production
   yet, so there is nothing to update until then):
   ```bash
   nano /opt/socialith/infra/vps/.env          # set TIKTOK_CLIENT_KEY=… and TIKTOK_CLIENT_SECRET=… yourself
   chmod 600 /opt/socialith/infra/vps/.env
   docker compose -f infra/vps/docker-compose.yml --env-file infra/vps/.env up -d api worker   # recreate to pick it up
   ```
4. **Remove the old value from your own machine:** edit the local `.env` (line `TIKTOK_CLIENT_SECRET=`), and
   overwrite or delete `socialith-backups\2026-11-19\private\.env`. Keep nothing that contains the old value.
5. **Check the provider's logs** (developer portal / app activity, if offered) for use of the app between the time
   it was pasted and the time you rotated it. Unfamiliar token exchanges or new authorizations mean someone used it:
   revoke the affected authorizations and tell the affected account owners.
6. **Confirm:** the old secret must be rejected by TikTok, and (once TikTok is enabled on the VPS) a real connect
   flow must succeed with the new one. Until step 1 is done the old secret is still valid — nothing in this repository
   can change that.
7. **Record the date** you rotated in your own notes and tick TD-07 in `docs/TECHNICAL_DEBT.md`.

The application only reads the secret from the environment (`@socialith/config`); nothing in the code, the images
or Git needs to change when it is rotated. Connected accounts' stored tokens are encrypted with
`TOKEN_ENCRYPTION_KEY`, not with the client secret, so they survive the rotation.

## 2. Rotation reference for every other secret

| Secret | Where it lives | Effect of rotating | How |
|---|---|---|---|
| `SESSION_SECRET` | `infra/vps/.env` | everyone is logged out | generate `openssl rand -hex 32`, edit `.env`, `up -d api worker` |
| `JWT_SECRET` | `infra/vps/.env` | invalidates outstanding signed links/tokens | same |
| MySQL app / migrate / backup / root passwords | `infra/vps/.env` **and** inside MySQL | none if done in order | `ALTER USER … IDENTIFIED BY …` in MySQL first, then edit `.env`, then `up -d`; the init script only runs on a fresh volume |
| `REDIS_PASSWORD` | `infra/vps/.env` | brief reconnect | edit `.env`, `up -d redis api worker` |
| **`TOKEN_ENCRYPTION_KEY`** | `infra/vps/.env` (+ separate backup) | **every stored OAuth token becomes unreadable — users must reconnect every account** | **Do not rotate casually.** There is no re-encryption tool yet; rotate only if the key itself leaked, accept the reconnect cost |
| `TIKTOK_*`, `META_APP_SECRET`, `GOOGLE_CLIENT_SECRET` | `infra/vps/.env` | provider-side invalidation | regenerate at the provider (§1), edit `.env`, `up -d api worker` |
| R2 access keys | `infra/vps/.env` | media access | create a new key pair in Cloudflare, switch, delete the old pair |
| Upload-Post API key (Phase 2) | `infra/vps/.env` | publishing | regenerate at the provider, edit `.env` |
| The owner's own password | database (scrypt hash) | — | change it in the app after signing in |
| GitHub access | your Git credential manager | — | revoke the token/sign out in GitHub → Settings, sign in again through the official Git credential flow; never paste a token anywhere |
| Deploy server SSH keys | your machine / server | — | generate a new key, add it, remove the old one from `authorized_keys` |

## 3. If you suspect any leak

1. **Rotate first, investigate second.**
2. Search Git: `node scripts/ci/check-repo-hygiene.mjs --history` (also runs in CI on every push) reports file and
   line, never the secret itself.
3. If a real secret was ever committed, rotating it is still required; rewriting history (`git filter-repo`) is a
   separate, deliberate step that needs your explicit approval because it changes every commit id.
4. Re-check the places in §1's table for the leaked secret.
