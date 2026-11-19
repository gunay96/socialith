# Socialith — MySQL database (decision, verification, configuration)

**Decision (project owner, 2026-11-19): MySQL is the database engine of the canonical
application.** The legacy PostgreSQL Docker stack is kept untouched as a rollback/reference
until the new deployment is verified; it is never migrated or deleted by this work.

## 1. Verification status — what is and is not proven

| Claim | Status | Evidence |
|---|---|---|
| The committed baseline migration applies to a fresh MySQL via `prisma migrate deploy` | **Verified** | MySQL **8.0.46** and **8.4.13**, empty databases, applied by the test setup itself; a second run is a no-op; `migrate status` = up to date |
| Live schema equals `schema.prisma` (no drift) | **Verified** | `prisma migrate diff --exit-code` → exit 0 on both versions |
| Real repositories/services work on MySQL (login, OAuth connect, the six search filters, long text, JSON, constraints, cascades, transactions) | **Verified** | `apps/api/src/integration/mysql.integration.test.ts`: **18/18 pass on 8.0.46 and on 8.4.13**, no mocks |
| Works on the production VPS, under production load, with production data volumes | **Not verified** | No such server exists yet |
| MySQL 5.7, MySQL 9.x, MariaDB | **Not tested** | Not supported by this decision; 5.7 is end-of-life |
| Backup/restore, TLS, replication, connection-pool behaviour under load | **Not verified** | Phase 1 work |

> A bug that unit tests could not see was found by the very first real run: both migration files had
> been written with a UTF-8 BOM (PowerShell 5.1 `-Encoding utf8`), so `prisma migrate deploy` failed with
> `P3019 … <PROVIDER NOT FOUND>`. It would have broken the first real deployment (and the cPanel ZIPs
> built earlier carry the broken files — they are superseded, do not use them). Fixed in commit `85b98b3`.

## 2. Version compatibility

Dependency: Prisma / `@prisma/client` **5.22.0** (pinned by the lockfile).

| MySQL | Result | Notes |
|---|---|---|
| 8.4.13 (LTS) | 18/18 ✓ | Authenticates with the default `caching_sha2_password`; strict `sql_mode` |
| 8.0.46 | 18/18 ✓ | Same |
| 5.7 / 9.x / MariaDB | untested | — |

**Recommendation: MySQL 8.4 LTS for the VPS.** 8.0 passes today but, per Oracle's published lifecycle,
reaches end of life in April 2026 (confirm against Oracle's current page before relying on it).
Prisma's own docs list "MySQL 5.6+" generically; they do not cover 5.22 specifically or 8.4, so the
version list above is **empirical** (our tests), not a vendor guarantee.

## 3. Schema facts (verified on the live servers)

- 17 application tables, all **InnoDB**, charset/collation **utf8mb4 / utf8mb4_unicode_ci**
  (set explicitly per table by the migration, so a host's default collation cannot change it).
- Prisma enums → native `ENUM(...)`; `Json` → native `JSON`; `String` → `VARCHAR(191)` unless `@db.Text`.
- `@db.Text` (no 191-char cap) on 17 columns: `PlatformConnection.encryptedAccessToken/encryptedRefreshToken`,
  `Content.caption`, `ContentVariation.caption`, `Campaign.description`, `ContentAsset.url`,
  `SocialAccount.avatarUrl/lastErrorMessage`, `Sound.soundUrl/artworkUrl`,
  `ContentTarget.externalPostUrl/errorMessage/deliveryNote`, `PublishAttempt.errorMessage/externalPostUrl`,
  `ContentGenerationJob.errorMessage`, `VideoRenderJob.errorMessage`. Verified round-trip with 1.6k–12k characters.
- `PlatformConnection.scopes` is `Json` (MySQL has no arrays). The `string[] ⇄ Json` boundary lives only in
  `platform-connection.repository.ts`. MySQL JSON columns take no `DEFAULT`, so every writer supplies it.
- Composite unique `(organization_id, platform, external_account_id)` fits MySQL's index key limit on both versions.

## 4. Search semantics (the six case-insensitive filters)

All six (`campaigns.name`, `content.caption`, `social_accounts.handle` OR `display_name`,
`sounds.artist`, `sounds.title` OR `sounds.artist`) use plain `contains`; the PostgreSQL-only
`mode: "insensitive"` was removed (Prisma's MySQL connector does not offer it). Case-insensitivity now comes
from the column collation and is **proven by the real-server tests**, not assumed.

Measured behaviour (identical on 8.0 and 8.4):
- Case-insensitive and accent-insensitive: `SOCIALITH`≈`socialith`, `café`≈`cafe`, `İstanbul`≈`istanbul`, `ğ`≈`g`, `ş`≈`s`.
- **Limitation:** Turkish dotless `ı` is a distinct letter: searching `kapi` does not find `Kapı` (and vice-versa).
- **Limitation (TD-25):** `%` and `_` typed in a search box act as LIKE wildcards (Prisma `contains` does not escape
  them). Not a security issue (parameterized, organization-scoped) but surprising; pinned by a characterization test.
- E-mail uniqueness is case-insensitive (`A@x.com` collides with `a@x.com`); the code already lowercases e-mails.

## 5. Known MySQL-specific risks (also in TECHNICAL_DEBT)

- **TD-26 — concurrent upserts can lose a race:** MySQL has no native Prisma `upsert`, so simultaneous OAuth callbacks
  for the same account produced `P2002` for 2–3 of 6 parallel calls in testing (never a duplicate row). Needs a
  catch-and-retry in `upsertSocialAccount`/`upsertPlatformConnection` before real OAuth traffic.
- `VARCHAR(191)` e-mail/name columns (practical, not RFC-complete e-mail lengths).
- Prisma checksums migrations byte-for-byte: `.gitattributes` forces LF so a Windows checkout cannot alter them.

## 6. Provisioning a clean production database (VPS, Phase 1 — reference)

```sql
CREATE DATABASE socialith CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- two accounts recommended: a migration user (DDL) and a runtime user (DML only)
CREATE USER 'socialith_app'@'<app-network-host>' IDENTIFIED BY '<generated secret>';
GRANT SELECT, INSERT, UPDATE, DELETE ON socialith.* TO 'socialith_app'@'<app-network-host>';
CREATE USER 'socialith_migrate'@'<app-network-host>' IDENTIFIED BY '<generated secret>';
GRANT ALL PRIVILEGES ON socialith.* TO 'socialith_migrate'@'<app-network-host>';
```
`DATABASE_URL=mysql://<user>:<url-encoded password>@mysql:3306/socialith?connection_limit=10`
Server defaults to keep: `utf8mb4`, `utf8mb4_unicode_ci`, strict `sql_mode` (the default). Never expose port 3306
publicly. Sizing/backup/TLS settings are finalized in Phase 1 and must be load-tested.

## 7. Configuration and code changes made for MySQL

| Change | Where |
|---|---|
| Provider `mysql`; `scopes` Json; 17 `@db.Text` columns | `packages/database/prisma/schema.prisma` |
| Single baseline migration, BOM-free, LF | `packages/database/prisma/migrations/20260922000000_init_mysql/`, `migration_lock.toml` |
| `mode:"insensitive"` removed (6 filters) | `apps/api/src/repositories/{campaign,content,social-account,sound}.repository.ts` |
| `scopes` string[]⇄Json boundary | `apps/api/src/repositories/platform-connection.repository.ts` |
| Real-DB test suite + throwaway MySQL compose | `apps/api/src/integration/`, `apps/api/vitest.integration.*`, `docker-compose.mysql-test.yml` |
| LF policy | `.gitattributes` |

The legacy PostgreSQL environment (Docker images tagged `:gen1`, volume `socialith-prod_socialith_postgres_data`,
logical dump in the private backup folder) was **not** modified.

## 8. Running the integration tests

```bash
docker compose -f docker-compose.mysql-test.yml up -d --wait          # MySQL 8.0 :3380, 8.4 :3384, Redis :6390 (throwaway, tmpfs)
# PowerShell:  $env:MYSQL_INTEGRATION_URL = "mysql://socialith:it-app-throwaway@127.0.0.1:3384/socialith_it"
#              $env:REDIS_INTEGRATION_URL = "redis://127.0.0.1:6390"
# bash:        export MYSQL_INTEGRATION_URL=...  REDIS_INTEGRATION_URL=...
pnpm --filter @socialith/api test:mysql                                # applies the migration, then 22 API tests
pnpm --filter @socialith/worker test:integration                       # 18 scheduling tests (real MySQL + real Redis/BullMQ)
docker compose -f docker-compose.mysql-test.yml down
```
The worker suite deletes organizations whose slug starts with `it-` before each test — point it only at a throwaway
database. The default `pnpm test` never touches a database and is unaffected.

## 8b. Phase 1 additions (branch `phase1-infrastructure`)

- **TD-26 resolved**: `connectAccount` re-runs its transaction on a lost upsert race (P2002/P2034). With retry disabled,
  9 of 10 simultaneous callbacks failed on MySQL 8.4; with it, 10/10 succeed across 3 rounds on 8.0.46 and 8.4.13.
- **Scheduling** is verified against real MySQL + Redis (worker suite) and, end to end, in the VPS compose stack.
- **Server settings are command-line arguments**, not a mounted `.cnf`: `mysqld` ignores a world-writable config file
  (a Windows bind mount is 0777), which made the first verification run use defaults without any error. Verified in force:
  `innodb_buffer_pool_size` 1 GiB, `utf8mb4_unicode_ci`, 7-day binlog, slow log on, strict `sql_mode`.
- Production accounts: DML-only app user, DDL migrate user (also scoped to `<db>_restore_check`), read-only backup user — see `infra/vps/mysql/initdb/`.

## 9. Rollback

Code: `git revert` the relevant commits or reset to tag `baseline-gen2` (note: that tag still contains the BOM bug).
Data: nothing production exists on MySQL. Legacy PostgreSQL stack: unchanged and runnable
(`docker compose … up` of the `socialith-prod` project, images `*:gen1`).
