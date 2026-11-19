# Source Control & Infrastructure Implementation Checklist

Legend: ✅ done and verified · 🟡 done, needs owner action to finish · ⬜ not started (planned) · 🔒 requires owner approval/purchase.
Last updated: 2026-11-19. Decisions this checklist implements: **MySQL** (database), **VPS** (infrastructure),
**Upload-Post** as core provider, development order Phase 0 → 9.

---

## A. Phase 0 — source control and security (first priority)

| # | Requirement | Status | Detail |
|---|---|---|---|
| A1 | Git available | ✅ | Git for Windows 2.56.0 installed per-user (`C:\Program Files\Git\cmd\git.exe`). New terminals pick it up; existing shells need a restart. |
| A2 | Private GitHub repository | 🟡 | **Needs you** (no GitHub credentials are available to me, and creating a repo in your account is yours to do). Steps in §F. |
| A3 | Full backup of the canonical repository | ✅ | `C:\Users\Yiğit\Desktop\socialith-backups\2026-11-19\` — see §D. |
| A4 | Inspect all env files, exclude secrets | ✅ | 4 env files found (`.env`, `.env.example`, `.env.tunnel`, `apps/web/.env`). Only `.env.example` is tracked; the rest are ignored by `.env` / `.env.*` / `!.env.example`. Every secret-class value in `.env` was searched for in all staged files: no real secret was found (only the documented local-dev `DATABASE_URL` default and the algorithm name). One TikTok client key in a doc was redacted before the first commit. Generic key patterns (private keys, AWS/GitHub/Slack/OpenAI-style tokens): none. |
| A5 | Initial baseline commit | ✅ | `bba7092` (tag `baseline-gen2`), 240 files. |
| A6 | Document canonical branch and structure | ✅ | §B and §C. |
| A7 | Confirm restore from backup | ✅ | See §D: clone from the bundle, frozen-lockfile install, Prisma generate, build, typecheck and all 262 tests pass; tree hash identical to the original. |

Commits so far (all on `main`):
```
68e484d chore: force LF line endings (Prisma migration checksums are byte-exact)
25468a7 test(db): real MySQL integration suite + throwaway MySQL 8.0/8.4 compose
85b98b3 fix(db): write migration_lock.toml and migration.sql without a UTF-8 BOM
bba7092 chore: baseline of canonical Socialith source (MySQL + scrypt generation)   [tag baseline-gen2]
```
Commit identity is a **placeholder** (`Socialith Dev <dev@socialith.invalid>`, repo-local) so your personal e-mail is not
published to GitHub. Before the first push you may set your GitHub no-reply address and rewrite author on these 4 commits
(§F). Not done automatically because it rewrites commit hashes.

## B. Repository structure

```
socialith/                      pnpm workspace + Turborepo, Node >= 20
├─ apps/
│  ├─ api/      Express API (auth, RBAC, accounts, campaigns, content, sounds, OAuth, analytics)
│  ├─ worker/   BullMQ worker (scheduling, publishing, status poll, analytics, token refresh, AI, render)
│  └─ web/      Next.js 14 dashboard (standalone output)
├─ packages/
│  ├─ auth/ config/ database/ (Prisma, MySQL) types/ ui/ video-engine/
├─ docs/        audit, PRD, roadmap, deployment, database, integration docs (this file included)
├─ docker-compose*.yml            legacy/Postgres-era files (see §E) + mysql-test
├─ .github/workflows/ci.yml       STALE (Postgres) — rewritten in Phase 1
└─ .gitignore / .gitattributes    secrets, artifacts, unrelated folders ignored; LF enforced
```
Deliberately **not** in the repository (ignored): `.env*` except the example, `node_modules`, build output,
`deploy-clean/` (old cPanel artifacts, superseded), `.claude/`, `backups/`, and two unrelated side projects that live in
the same folder (`alroca-intro/` 534 MB, `colleb-post/`) — they remain untouched on disk and should get their own repositories.

## C. Branch and commit policy (proposed — change if you prefer)

- **`main` is the canonical, always-deployable branch.** No force-push, no direct unreviewed pushes once the GitHub repo exists
  (enable branch protection: PR + passing CI + no force-push).
- Work happens on `phase-<n>/<topic>` branches (e.g. `phase-1/worker-recovery`), merged by PR after the phase report is approved.
- Tags: `baseline-gen2` (canonical baseline), `phase-<n>-approved` after each approved phase (rollback anchors).
- Conventional commit prefixes (`feat|fix|test|chore|docs|refactor`), one logical change per commit, migrations never edited after
  they have been applied anywhere (add a new migration instead).
- CI (Phase 1) must include: install with frozen lockfile, typecheck, unit tests, MySQL integration tests, a secret scanner, and a
  check that no `.env*` (other than the example) is tracked.

## D. Backups and restore

Location (outside the repository): `C:\Users\Yiğit\Desktop\socialith-backups\2026-11-19\`

| Item | Purpose | Secrets? |
|---|---|---|
| `socialith-repo-2026-11-19.bundle` | Complete Git history (restore with `git clone <bundle> <dir>`) | no |
| `socialith-source-HEAD-2026-11-19.zip` | Plain source snapshot of `HEAD` at baseline time | no |
| `private\.env`, `.env.tunnel`, `apps-web.env` | Your real local env files | **yes — never upload, never commit** |
| `private\gen1-postgres-dump.sql` | Logical dump of the legacy PostgreSQL DB (seed data only; contains a seed password *hash*) | sensitive-ish |
| `private\deploy-clean\` | Old cPanel build artifacts — **superseded and contain the BOM bug** | no |

Two generations of the bundle exist: `socialith-repo-2026-11-19.bundle` (baseline `bba7092` only — contains the BOM defect,
keep only as the historical baseline) and `socialith-repo-phase0-final.bundle` (all Phase 0 commits, **use this one**) with
its source zip. SHA-256 values are in `SHA256SUMS.txt` next to them. **Re-create the bundle after each approved phase**:
`git bundle create <dir>\socialith-repo-<label>.bundle --all`.

**Restore procedure (verified):**
```bash
git clone socialith-repo-2026-11-19.bundle socialith && cd socialith
cp <private>/.env .env                       # secrets come from the private backup, never from Git
pnpm install --frozen-lockfile
pnpm --filter @socialith/database generate
pnpm -r build && pnpm -r typecheck && pnpm -r test
```
Verification run (clean clone of the bundle in a temp folder, since removed): install ✓, Prisma generate ✓, build ✓,
typecheck ✓, tests 262/262 ✓, restored commit `bba7092` and tree `9488d2c…` identical to the original, and the clone contained no
env file other than `.env.example`.

## E. Legacy PostgreSQL Docker environment — preserved as rollback/reference

- Untouched during this work: containers `socialith-prod-*` (api healthy, web, postgres, redis, nginx, cloudflared; the worker is
  still crash-looping — **not** repaired yet, that is Phase 1) and the dev-only `socialith-postgres/redis`.
- Non-destructive additions only: image tags `socialith-prod-{api,worker,web}:gen1` pin the old build; a read-only logical dump
  was taken (§D). Volumes `socialith-prod_socialith_postgres_data`, `…_redis_data`, `…_media_data` untouched.
- It must stay until the new VPS deployment is verified. Do not run the new MySQL code against those volumes.

## F. Create the private GitHub repository (owner action) — 🟡

1. On github.com create an **empty private** repository (no README/license/.gitignore), e.g. `socialith`.
2. Optional but recommended — use your GitHub no-reply e-mail for authorship before pushing:
   ```bash
   git config user.name "<your name>"
   git config user.email "<id>+<username>@users.noreply.github.com"
   git rebase --root --exec "git commit --amend --no-edit --reset-author"   # rewrites the 4 local commits
   ```
   (Keep the tag by re-tagging: `git tag -f -a baseline-gen2 <new hash of the baseline commit> -m "Canonical baseline"`.)
3. Connect and push (authenticate in the browser/Git Credential Manager when prompted):
   ```bash
   git remote add origin https://github.com/<you>/socialith.git
   git push -u origin main --tags
   ```
4. Enable branch protection on `main` and **secret scanning / push protection** in the repository settings.
5. Tell me the repository URL; I will not need any token — pushing stays with you unless you decide otherwise.

## G. Phase 0 — database foundation

| Item | Status |
|---|---|
| Verify Prisma schema and MySQL migration against real servers | ✅ MySQL 8.0.46 and 8.4.13; no drift; see `docs/DATABASE_MYSQL.md` |
| Compatible MySQL version | ✅ verified 8.0 and 8.4; **recommend 8.4 LTS** |
| Clean MySQL database prepared | ✅ reproducible throwaway servers (`docker-compose.mysql-test.yml`); production provisioning SQL documented, executed in Phase 1 on the VPS |
| Fix the six case-insensitive filters | ✅ already corrected in code; now **proven** on a real server (18/18 tests) |
| Document database configuration changes | ✅ `docs/DATABASE_MYSQL.md` |
| Old PostgreSQL untouched | ✅ |
| "MySQL integration works" | ✅ only in the sense tested: real server, fresh DB, 18/18 on two versions. **Not** yet on the VPS or under load. |
| Defects found by the real test | BOM in migration files (fixed); `%`/`_` not escaped in search (TD-25, pinned); concurrent-upsert race (TD-26, open) |

## H. Phase 0 — deployment foundation (documents; no purchase, no DNS)

| Item | Status |
|---|---|
| Target architecture, sizing, rollout order | ✅ `docs/DEPLOYMENT_PLAN.md` (updated for MySQL/VPS) |
| Environment variable matrix (api **and worker** URL variables) | ✅ in DEPLOYMENT_PLAN §3 |
| Upload-Post architecture | ✅ `docs/UPLOAD_POST_INTEGRATION.md` (verification plan in Phase 2) |

## I. Phase 1 — infrastructure repair (⬜ not started; starts only after you approve Phase 0)

Owner prerequisites (🔒 nothing below is done or purchased by me):
- [ ] 🔒 Choose provider and buy the VPS (Linux, 4 vCPU / 8 GB / ≥80 GB SSD, Ubuntu LTS); give me the IP and an SSH access method.
- [ ] 🔒 Decide the production domain and create the DNS A/AAAA records yourself (I never modify DNS).
- [ ] Create: Cloudflare R2 bucket + keys, transactional e-mail provider, a *rotated* TikTok secret.
- [ ] Upload-Post: API key for a **controlled test profile** first (needed for Phase 2).

Engineering checklist (Phase 1):
- [ ] VPS hardening: non-root deploy user, SSH keys only, firewall 22/80/443, unattended security updates, fail2ban.
- [ ] `docker-compose.vps.yml`: caddy/nginx (HTTPS), web, api, worker, MySQL 8.4, Redis (AOF on), FFmpeg in the worker image; no published DB/Redis ports.
- [ ] Env: one shared URL set (`NEXT_PUBLIC_APP_URL`, `API_PUBLIC_URL`, web build arg) given to **api, worker and web build**; boot-time check that fails loudly on localhost in production.
- [ ] Worker boot repair (root cause already identified: worker lacks the URL overrides the api gets) with a compose healthcheck.
- [ ] Scheduling reliability: DB→Redis reconciliation sweeper; recovery of missing/overdue jobs; **stale-content guard** (a scheduled item overdue by more than a configurable window is *held for review*, never auto-published); the 5 overdue seed targets are explicitly **never executed**.
- [ ] Redis persistence (AOF `everysec`) and MySQL backups (nightly dump + binlog/PITR decision) to R2, with a **restore drill**.
- [ ] Rewrite CI for MySQL (`docker-compose.mysql-test.yml` services), secret scan, tracked-env check.
- [ ] Fix TD-26 (upsert race) before real OAuth traffic.
- [ ] Phase report: files, DB changes, tests, risks, rollback; wait for approval.

## J. Open decisions / actions waiting on you
1. Create the private GitHub repo and push (§F).
2. Approve Phase 0 so Phase 1 can start.
3. Decide when to buy the VPS and which provider (nothing is purchased automatically).
4. Confirm: should the two unrelated side projects get their own repositories?
