# Socialith — Phase 1 acceptance report

Branch `phase1-infrastructure` (never merged into `main`, never deployed). Date: 2026-11-19.
Scope: VPS environment, worker recovery, scheduling reliability — plus the final-hardening items TD-32 (production
owner bootstrap), TD-17 (CI) and the credential-rotation procedure.

> **Status: ready for owner review. Not merged. Phase 2 (Upload-Post) not started.**

## 1. What Phase 1 delivered (summary)

| Area | Result | Evidence / doc |
|---|---|---|
| Worker boot repair, one shared URL set, config refuses localhost/missing URLs in production | done | `VPS_DEPLOYMENT.md` §1, §7 |
| Scheduling reconciler (DB → Redis), stale-content hold, stuck-PUBLISHING recovery, demo-account publish guard, self-healing schedules | done, drilled on a real stack | `OPERATIONS_RUNBOOK.md` §5 |
| OAuth concurrent-callback upsert race (TD-26) | fixed: 9/10 failed → 10/10 succeed | `DATABASE_MYSQL.md` §8b |
| VPS Docker Compose (Caddy/MySQL 8.4/Redis/migrate/api/worker/web, FFmpeg), backup/restore/smoke scripts | done, verified locally | `VPS_DEPLOYMENT.md`, `OPERATIONS_RUNBOOK.md` |
| **TD-32 production owner bootstrap** | done | `VPS_DEPLOYMENT.md` §4a |
| **TD-17 CI for MySQL 8.4 + Redis** | done (first GitHub run pending) | `CI.md` |
| **Credential rotation procedure (TikTok secret)** | documented; **rotation is owner-only, pending** | `SECURITY_CREDENTIAL_ROTATION.md` |

## 2. Final-hardening work in detail

### TD-32 — production owner bootstrap
`node apps/api/dist/cli/bootstrap-owner.js` (source `apps/api/src/cli/`, `services/bootstrap-owner.service.ts`,
`validation/bootstrap-owner.validation.ts`). Exact operator procedure: **`VPS_DEPLOYMENT.md` §4a**.

| Requirement | How it is met | Proven by |
|---|---|---|
| Works with MySQL 8.4 | Prisma + one SERIALIZABLE transaction | integration suite on 8.4.13 and 8.0.46; real api image against 8.4 |
| Independent of seed data | creates only organization + OWNER + audit row | test asserts 0 social accounts/connections/campaigns/content/sounds/invitations |
| Never creates demo accounts | no sample data path exists; refuses a database that has any | `SEED_DATA_PRESENT` test; CLI exit 3 test |
| Password hashed by the existing architecture | `hashPassword` from `@socialith/auth` (scrypt v1) | test: hash prefix `scrypt$v1$`, `verifyPassword` true/false, real `authenticateWithPassword` login; real production-mode API login HTTP 200 role OWNER |
| No additional owners | refuses if **any** user exists | `NOT_EMPTY` tests (different identity, viewer with same e-mail, other org) |
| Explicit production validation | `NODE_ENV=production` + full config valid + https URL + `--confirm-domain` equals the deployment hostname | 10 gate tests; CLI refuses (exit 2) before reading a password or touching the DB |
| No passwords in logs/terminal history | no `--password` option (rejected with an explanation); hidden prompt, `--password-stdin`, `--password-file`; never printed, never in audit metadata or errors | tests assert the password and the DB password never appear in any output; real pseudo-terminal drill shows no echo |
| Idempotent / safely rejects repeats | identical owner → exit 0 "already initialized", **password not modified**; anything else → exit 3 | integration + CLI tests, real-image drill |
| Race-safe | SERIALIZABLE transaction + deadlock retry | **10 rounds × 8 simultaneous runs, repeated on 8.4 and 8.0: exactly one owner every time** |
| Automated tests | +52 unit, +17 real-MySQL integration | §3 |

Two defects were found *by the validation itself* and fixed before acceptance (both in the report because they would
have shipped otherwise):

1. **Race:** the first design used MySQL `GET_LOCK`; the real concurrency test created **two owners** (1 in 3 rounds
   on 8.0) because the named lock was released before the transaction committed. Replaced by a SERIALIZABLE
   transaction (the engine guarantees the outcome), regression-tested 10 rounds × 8 racers × 2 runs × 2 versions.
2. **BOM in the password:** Windows PowerShell 5.1 prepends U+FEFF to text piped to a program (Notepad does the same
   to files). The stored password then began with an invisible character and the owner got HTTP 401 at login. The
   command now strips one leading BOM and one trailing newline; covered by unit tests and re-drilled end to end.

### TD-17 — CI
`.github/workflows/ci.yml`; details in `CI.md`. Jobs: `hygiene` (tracked env/keys/dumps, BOM/CRLF, secret scan of the
tree and the **entire** Git history), `verify` (MySQL 8.4 + Redis, lint, typecheck, unit, `migrate deploy`, drift
check, API + worker integration, build), `images` (compose config, `bash -n`, image builds, bootstrap CLI present).
No PostgreSQL, no `secrets.*`, `contents: read`, throwaway credentials only. The scanner itself was proven on a
synthetic leaky repository (detects a `.env`, a BOM, a URL password, and an AWS key that had been *deleted* from
history; ignores the allow-listed throwaway values) and finds nothing in this repository.

### Credential rotation
`SECURITY_CREDENTIAL_ROTATION.md`. Findings: the TikTok client secret is **not** in Git history (all refs), the
tracked tree, the bundles or the source ZIPs (searched for the exact value; 0 hits). It exists only in the local
git-ignored `.env`, the private backup copy of that file, the legacy containers' environment, and the chat transcript.
Rotation at TikTok is the only fix and only you can do it.

## 3. Test results (final run, 2026-11-19)

| Suite | Result |
|---|---|
| Lint (9 tasks) / Typecheck (9 tasks) | pass (warnings only, 0 errors) |
| **Unit — all workspaces** | config 16, auth 37, web 2, worker 75, video-engine 7, api 227 (+1 POSIX-only skip) = **364 passed** |
| **MySQL 8.4.13 integration — API** (incl. owner bootstrap, OAuth race) | **45/45**, plus 3 consecutive repeats 45/45 |
| **MySQL 8.4.13 + Redis — worker** (scheduling, reconciler, stale hold, repeatable re-assert) | **18/18** |
| MySQL 8.0.46 — API / worker (compatibility) | 45/45 / 18/18 |
| Schema drift (`migrate diff --exit-code`) | none; negative test (added a column) fails the step as intended |
| CI replay locally (every `run:` step of `ci.yml` against fresh MySQL 8.4 + Redis) | lint, typecheck, unit, migrate, drift, API + worker integration, compose config, shell syntax, image builds (api/worker/web), CLI in image — all pass. `pnpm build` passes for 8 of 9 packages on Windows; the web `next build` stops at a **Windows-only symlink permission error** while writing its standalone output (EPERM) — the same app builds in the Linux Docker image |
| Repository hygiene incl. full history | OK (288 tracked files) |
| Real stack drill (production api image, MySQL 8.4, DML-only account) | see `VPS_DEPLOYMENT.md` §7 (owner bootstrap rows) |

## 4. Database changes
**None.** No migration was added in the hardening pass; the bootstrap command only inserts rows through the existing
schema (`organizations`, `users`, `audit_logs`; new audit action string `OWNER_BOOTSTRAPPED` — a plain string column).

## 5. Files changed in the hardening pass
- New: `apps/api/src/cli/{bootstrap-owner,bootstrap-owner-cli,password-input,production-gate}.ts` (+ 3 test files),
  `apps/api/src/services/bootstrap-owner.service.ts` (+ test), `apps/api/src/validation/bootstrap-owner.validation.ts`
  (+ test), `apps/api/src/integration/bootstrap-owner.integration.test.ts`, `scripts/ci/check-repo-hygiene.mjs`,
  `docs/CI.md`, `docs/SECURITY_CREDENTIAL_ROTATION.md`, `docs/PHASE1_ACCEPTANCE.md`.
- Modified: `.github/workflows/ci.yml` (rewritten), `package.json` (+2 scripts), `apps/api/src/repositories/
  audit-log.repository.ts` (+1 action), `docs/VPS_DEPLOYMENT.md`, `docs/TECHNICAL_DEBT.md`,
  `docs/SOURCE_CONTROL_AND_INFRA_CHECKLIST.md`.

## 6. Remaining risks (honest list)
1. **TikTok secret not yet rotated** — owner action; until then the old secret is valid and exposed (TD-07).
2. **CI has not run on GitHub yet** (no push). It was replayed locally step by step, not executed by a GitHub runner;
   branch protection requiring the three checks is an owner action.
3. **No off-site backups, PITR undrilled, no monitoring stack** (TD-34, TD-35) — must be done before real users.
4. Not verified on a real server: Let's Encrypt/DNS, internet reachability, load, heavy FFmpeg, any real provider
   (publish/OAuth/e-mail/R2/AI).
5. The bootstrap command was validated on MySQL 8.4/8.0 and in the Linux image; the hidden-prompt path was exercised
   on a real pseudo-terminal inside the image, not on a physical keyboard/terminal emulator.
6. Reaching 80/443 of the VPS, firewalling and SSH hardening are documented, not executed (no server exists).
7. Unchanged open debt: TD-25, TD-30, TD-31, TD-33, TD-36, TD-37, TD-40.

## 7. Rollback procedures

**A. Code / branch (nothing is merged or deployed).** `main` is untouched at `2bc24cf`. To abandon Phase 1 simply do
not merge; the branch can be deleted locally (`git branch -D phase1-infrastructure`) and on GitHub. A backup bundle
of everything exists (`Desktop\socialith-backups\2026-11-19\…phase1-infrastructure-<sha>.bundle`, hash in
`SHA256SUMS.txt`); restore with `git clone <bundle> restored && cd restored && git checkout phase1-infrastructure`.

**B. Only the final-hardening commits.** After merging, to undo just them: `git revert <docs commit> b1814b8 a1c37b2`
(newest first). Reverting the CI commit restores the old PostgreSQL-era workflow, which is red by design; prefer
disabling the workflow in GitHub Actions or fixing forward. Reverting the CLI commit removes the owner-bootstrap
command and its tests; it changes no data and no schema.

**C. An owner created by mistake** (wrong e-mail/password) on a deployment that holds **no other data yet**:
the clean way is the app (sign in, change the password) — or, if the e-mail itself is wrong and nothing else exists:
```bash
COMPOSE="docker compose -f infra/vps/docker-compose.yml --env-file infra/vps/.env"
$COMPOSE --profile tools run --rm backup sh /scripts/backup-mysql.sh      # always back up first
$COMPOSE exec mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'
mysql> SELECT id, slug FROM organizations;                       -- check it is the one you mean
mysql> DELETE FROM organizations WHERE slug = 'your-slug';       -- cascades to its users and audit rows
```
then run the bootstrap again. **Destructive** — never run this on a database holding real work; restore a backup instead.

**D. CI.** Disable the workflow in GitHub (Actions → CI → ⋯ → Disable) or revert `b1814b8`. No secrets or settings
exist on the GitHub side to clean up.

**E. VPS stack (when one exists).** `docker compose … down` stops it and keeps the data volumes; `down -v` **destroys
the data** — only with a verified backup. Deploy rollback to a previous tag is in `VPS_DEPLOYMENT.md` §5; data rollback
is `OPERATIONS_RUNBOOK.md` §3. Nothing was deployed, so nothing needs rolling back today.

**F. Legacy PostgreSQL system.** Untouched and still runnable (`socialith-prod-*` containers, `:gen1` images,
volume `socialith-prod_socialith_postgres_data`, logical dump in the private backup folder).

## 8. What the owner must do
1. Review the branch and approve (or request changes) — then decide whether to merge `phase1-infrastructure` into `main`.
2. Push the branch from your own terminal (the assistant cannot authenticate to GitHub):
   `git push -u origin phase1-infrastructure`; watch the first CI run; fix forward on the branch if needed.
3. **Rotate the TikTok client secret** (`SECURITY_CREDENTIAL_ROTATION.md` §1).
4. After the first green CI run, require `hygiene`, `verify`, `images` in branch protection for `main`.
5. Phase 2 starts only on your explicit approval.
