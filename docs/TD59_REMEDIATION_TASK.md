# TD-59 remediation task — MySQL-safe locking for native OAuth token refresh

Status: **prepared, not started.** This is a separate task from Phase 4 and must be done on its own branch from `main`, reviewed and merged independently. Nothing in this document has been implemented.

## 1. The defect

`apps/worker/src/publishing/token.ts`, `refreshAndPersist()` (line ≈156) opens a Prisma transaction and runs:

```ts
await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${connection.id})::bigint)`;
```

`pg_advisory_xact_lock` and `hashtext` are PostgreSQL functions. On MySQL (the canonical database) the statement fails with a syntax/unknown-function error, so **every token refresh of a natively connected account fails**: the just-in-time refresh in `resolveAccessToken` (publishing, publish-status poll, analytics sync) and the scheduled refresh (`forceRefreshAccessToken`, token-refresh queue). The unit test (`token.test.ts`) mocks `$queryRaw`, so no test caught it.

Affected: accounts connected through the native OAuth flows (TikTok, Instagram, YouTube) — rows with a `platform_connections` record.
Not affected: Upload-Post destinations (`publishingProvider = UPLOAD_POST`); they have no `PlatformConnection` and never reach this code.

## 2. Production restriction (in force until this task is closed)

> **Native OAuth token refresh must not be enabled on MySQL until this issue is fixed and verified.**

Concretely, on any MySQL deployment:

1. Leave `TIKTOK_CLIENT_KEY/SECRET`, `META_APP_ID/SECRET` and `GOOGLE_CLIENT_ID/SECRET` **empty**. The API then refuses to start a native OAuth flow (`configuration_error`), so no native connection can be created.
2. Do not insert or import `platform_connections` rows by hand.
3. Publish through Upload-Post only (the Phase 2/3 path).
4. If a native connection somehow exists, expect `publishing`, `status poll` and `analytics sync` for that account to fail at the token step; treat it as this defect, not as a provider problem.

The restriction is recorded in `TECHNICAL_DEBT.md` (TD-59), `VPS_DEPLOYMENT.md` §2a, `OPERATIONS_RUNBOOK.md` §6, and next to the credential variables in `infra/vps/.env.example`. It is lifted only by the owner, after §6 below.

## 3. Task scope

In scope: replace the PostgreSQL lock in `refreshAndPersist` with MySQL-compatible transactional locking, keep the behaviour identical (one refresh per connection at a time; a caller that waited re-uses the winner's token instead of refreshing again), add the missing MySQL test.
Out of scope: any other file, the OAuth providers, Upload-Post, schema changes (no migration is needed), Phase 5.

## 4. Recommended design

**Use a row lock on the connection row, not a named lock.**

```sql
SELECT id, encrypted_access_token, encrypted_refresh_token, revoked_at
FROM platform_connections WHERE id = ? FOR UPDATE
```

executed inside the existing interactive transaction. Why this is the safe choice:

| Property | `SELECT … FOR UPDATE` | `GET_LOCK()` / `RELEASE_LOCK()` |
|---|---|---|
| Released automatically on commit, rollback, error **and** connection loss | yes | **no**: a session-level lock survives the transaction and is released only by an explicit `RELEASE_LOCK` or the end of the session |
| Works with Prisma's connection pool | yes (the interactive transaction pins one connection) | risky: a missed release leaves the lock on a pooled connection that is reused |
| Scoped to exactly the one connection row | yes | scoped by an arbitrary string |
| Needs no new table or migration | yes | yes |

Details the implementation must get right:

1. **Read the credential from the locked SELECT itself**, and use *its* values for the existing checks ("revoked or removed", "stored token changed since the caller's snapshot", "refresh token present"). Do not rely on a separate plain `findUnique` afterwards: under InnoDB's default REPEATABLE READ a plain read may use an older snapshot than the locked read. (Reading `encrypted_*` in raw SQL: map snake_case columns explicitly; never log them.)
2. **Lock wait:** the refresh makes a real HTTP call while holding the lock, inside `{ timeout: 20_000 }`. MySQL's `innodb_lock_wait_timeout` defaults to 50 s, longer than that transaction timeout, so the Prisma timeout is what bounds a waiter. A waiter that times out must fail with a **retryable** error (`PublishError` retryable) — never proceed without the lock and never refresh twice. Add a test for it.
3. **Order of operations is unchanged:** lock → re-check under lock → provider refresh → `update` → commit. After the winner commits, a waiter acquires the lock, sees a changed `encrypted_access_token`, and returns the winner's token without calling the provider.
4. **Deadlock safety:** the transaction touches only this one row and nothing else before the lock, so there is no lock-ordering risk; Prisma already retries nothing here, keep it that way.
5. **No PostgreSQL leftovers:** after the change, `grep -rE "pg_|hashtext|::bigint|DISTINCT ON|ILIKE" apps packages --include=*.ts` must show no non-comment hit (the TD-54 sweep already cleared the API).

## 5. Tests required (real MySQL 8.4 + a mocked provider HTTP)

Add `apps/worker/src/integration/token-refresh.integration.test.ts` (the worker integration config already provides MySQL + Redis):

| Test | Proves |
|---|---|
| two concurrent refreshes of the same connection | the provider is called **exactly once**; both callers return the same new token; the row holds the new token |
| two refreshes of different connections | neither blocks the other (run in parallel, both succeed) |
| provider failure while holding the lock | the transaction rolls back, the lock is released, and the next caller can refresh |
| a waiter that times out | fails retryably, never refreshes twice, leaves the row unchanged |
| connection revoked while a waiter waits | the waiter fails with the configuration error, no provider call |
| a caller whose snapshot is already stale | returns the stored token without a provider call (the existing semantics) |
| Instagram (access-token refresh input) and TikTok/YouTube (refresh-token input) | the right credential is sent for each platform |

Keep the existing unit tests passing (adapt the `$queryRaw` mock to the new statement; do not weaken any assertion). Run the full unit and integration suites, lint, typecheck and the Docker builds.

## 6. Conditions for lifting the production restriction

All of:
1. The fix is merged to `main` with the integration test green in GitHub Actions on MySQL 8.4.
2. The PostgreSQL sweep in §4.5 is clean.
3. The owner explicitly approves enabling native OAuth, **and** a first native connection is made with a **designated test account** only after separate, explicit authorization (the standing rule: no real publishing without it). Verification is read-only first: connect, wait for or force one refresh, confirm the token rotated and the row is consistent.
4. `TECHNICAL_DEBT.md`, `VPS_DEPLOYMENT.md`, `OPERATIONS_RUNBOOK.md` and `.env.example` are updated to remove the restriction in the same change.

## 7. Optional interim safeguard (a separate owner decision)

Until the fix lands, a boot-time guard could make the restriction impossible to violate by accident: when the database is MySQL and any native OAuth credential is set, refuse to start with a message pointing here. It is small and reversible, but it is code, so it is **not** part of Phase 4 and not part of this task unless the owner asks for it.

## 8. Hand-off prompt (for a fresh session)

> In the Socialith repo, fix TD-59 as specified in `docs/TD59_REMEDIATION_TASK.md`. Branch from `main`, never commit to `main`, never force-push, do not merge. Replace `pg_advisory_xact_lock(hashtext(...))` in `apps/worker/src/publishing/token.ts` `refreshAndPersist` with `SELECT … FOR UPDATE` on the `platform_connections` row, reading the credential from the locked SELECT, preserving semantics. Add the MySQL integration tests of §5. Run lint, typecheck, all unit tests, MySQL 8.4 + Redis integration tests and the Docker builds; run the full-history secret scan; push the branch and wait for the three GitHub Actions checks. Do not enable native OAuth, do not publish to any real account, do not change anything outside the scope in §3. Report and wait for approval.
