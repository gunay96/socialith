# Socialith — continuous integration

Workflow: `.github/workflows/ci.yml`. Runs on pull requests to `main`, pushes to `main` and `phase*` branches, and
manually (`workflow_dispatch`). It tests the **canonical** architecture — MySQL 8.4, Redis, BullMQ worker, Docker
Compose on a VPS — and has no PostgreSQL anywhere (the legacy PostgreSQL generation is retained only as a rollback
reference, outside CI).

## Security posture of the pipeline

- Declares no `secrets.*` and requests `permissions: contents: read`: **no production credential can reach it.**
- Every value in the workflow is a throwaway for databases that live only for the job, on the runner's loopback
  interface (`it-app-throwaway`, `ci-only-placeholder-secret-not-for-production`, `abab…`). They are the same values
  already committed in `docker-compose.mysql-test.yml`, and are allow-listed (narrowly) in the secret scanner.
- Third-party actions are the official `actions/*` and `pnpm/action-setup`, pinned to a major version.

## Jobs

| Job | Purpose | Steps |
|---|---|---|
| `hygiene` | Fast repository gate | `node scripts/ci/check-repo-hygiene.mjs --history`: no tracked `.env`/keys/dumps/backups; no BOM or CRLF where it breaks Prisma/shell/YAML; no credential-shaped strings in the tree **or anywhere in Git history**. Findings print file:line and the pattern name, never the matched text. |
| `verify` | The real test matrix | start **MySQL 8.4 + Redis 7** (`docker-compose.mysql-test.yml`, the same file developers use, so collation/charset match) → install → Prisma generate → **lint** → **typecheck** → **unit tests** → `prisma migrate deploy` → **schema-drift check** (`prisma migrate diff --exit-code`) → **API integration tests** (real MySQL) → **worker integration tests** (real MySQL + Redis/BullMQ) → **build** → tear down |
| `images` | Deployment artifacts | `docker compose config` on the VPS file with the placeholder env; `bash -n` on every shell script; build the `api`, `worker`, `web` images; check that the owner-bootstrap CLI is present in the API image (`--help`) |

The integration suites include the production owner bootstrap (TD-32): exactly-one-owner under 8-way concurrency,
idempotence, seed-data refusal, real scrypt login, and the full CLI path.

## Running the same steps locally

```bash
docker compose -f docker-compose.mysql-test.yml up -d --wait mysql84 redis
export MYSQL_INTEGRATION_URL="mysql://socialith:it-app-throwaway@127.0.0.1:3384/socialith_it"
export REDIS_INTEGRATION_URL="redis://127.0.0.1:6390"
export DATABASE_URL="$MYSQL_INTEGRATION_URL" REDIS_URL="$REDIS_INTEGRATION_URL"
export SESSION_SECRET=ci-only-placeholder-secret-not-for-production
export TOKEN_ENCRYPTION_KEY=$(printf 'ab%.0s' $(seq 32))

pnpm install --frozen-lockfile && pnpm db:generate
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @socialith/database exec prisma migrate deploy
pnpm --filter @socialith/database exec prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
pnpm test:integration            # api (MySQL) then worker (MySQL + Redis)
pnpm build
pnpm check:hygiene               # same script as the hygiene job
docker compose -f docker-compose.mysql-test.yml down -v
```

PowerShell (Windows): set the same variables with `$env:NAME = "value"`. Two Windows-only caveats: `next build`
for the web app needs symlink permission (Developer Mode or an elevated shell) to write its `standalone` output — it
builds fine on Linux/CI and in the Docker image; and `pnpm exec … --exit-code` reports exit code 1 instead of 2 on
drift (any non-zero fails the step).

## Branch protection (owner action)

CI can only block a merge if GitHub is told to require it. In the repository settings (Branches → Branch protection
rule for `main`) require the status checks **hygiene**, **verify** and **images**, and require a pull request.
Nothing in this repository can switch that on for you.

## Known limits

- The workflow could not be executed on GitHub from this environment (no push yet); it was validated by parsing the
  YAML, then **replaying every step locally** against fresh MySQL 8.4 + Redis containers, and by building the images
  with the same commands. First real run on GitHub may still surface runner-specific issues (e.g. image pull limits);
  fix forward on the branch.
- Only MySQL 8.4 runs in CI. MySQL 8.0 compatibility was verified manually (`docs/DATABASE_MYSQL.md`) and is not
  re-checked on every push.
- No end-to-end browser tests, no load tests, no real provider calls (none are configured).
