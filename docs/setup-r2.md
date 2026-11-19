# Cloudflare R2 setup (production object storage)

Socialith stores uploaded media and rendered video output through a real
storage abstraction — `packages/video-engine/src/storage.ts`'s
`AssetStorage` interface, with two implementations:

- `LocalAssetStorage` — real local-disk storage, credential-free, used
  automatically whenever R2 isn't configured. Fine for local development;
  not recommended for a multi-instance or ephemeral-filesystem production
  deployment (an uploaded file wouldn't survive a redeploy or be visible
  to a different container instance).
- `R2AssetStorage` — real Cloudflare R2 (S3-compatible) storage via the
  AWS SDK's `S3Client` pointed at R2's own endpoint. Selected automatically
  once `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` are all
  set — see `resolveAssetStorageConfig` in `@socialith/config`.

## 1. Create an R2 bucket

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com/) → **R2**.
2. **Create bucket** — name it (e.g. `socialith`), any region.
3. Note your **Account ID**, shown on the R2 overview page.

## 2. Create an API token

1. R2 → **Manage R2 API Tokens** → **Create API Token**.
2. Permissions: **Object Read & Write**, scoped to the bucket you created.
3. Copy the generated **Access Key ID** and **Secret Access Key** — the
   secret is shown only once.

## 3. Environment variables

```bash
R2_ACCOUNT_ID="<Account ID from the R2 overview page>"
R2_ACCESS_KEY_ID="<Access Key ID from the API token>"
R2_SECRET_ACCESS_KEY="<Secret Access Key from the API token>"
R2_BUCKET_NAME="socialith"
# Optional — see below.
R2_PUBLIC_URL=""
```

## 4. Public access vs. signed URLs

By default (`R2_PUBLIC_URL` unset), every download URL Socialith
generates is a real, time-limited **presigned R2 GET URL** (1 hour) —
favoring signed/controlled access over an open bucket, per this
project's security requirements. `apps/worker/src/processors/publishing.processor.ts`
regenerates a fresh signed URL from the asset's stored key right before
every publish attempt, so a target scheduled days out never gets handed
an already-expired URL.

If you'd rather serve from a public bucket or a custom domain (e.g. for a
CDN in front of R2), enable **Public Access** on the bucket (or set up a
custom domain under R2 → your bucket → Settings) and set:

```bash
R2_PUBLIC_URL="https://<your-public-bucket-or-custom-domain>"
```

When set, every download URL is that stable public base URL + the
object's key instead of a presigned one.

## 5. Without R2 configured

Leaving all three required R2 vars unset is a fully supported,
intentional configuration — Socialith falls back to the real local-disk
backend (`LOCAL_STORAGE_DIR`, served at `API_PUBLIC_URL/media`) with no
code changes needed. This is the default for local development.
