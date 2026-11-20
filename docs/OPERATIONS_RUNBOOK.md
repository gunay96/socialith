# Socialith — Operations runbook (backup, restore, monitoring)

Applies to the VPS stack in `infra/vps/` (see `VPS_DEPLOYMENT.md`). In every command below,
`COMPOSE` stands for:

```bash
COMPOSE="docker compose -f infra/vps/docker-compose.yml --env-file infra/vps/.env"
```

Everything marked **(drilled)** was executed against a real MySQL 8.4 + Redis stack on 2026-11-19; items marked
**(not drilled)** are specified but have not been run on a real server.

## 1. What is where, and what is recoverable

| Data | Where | Loss means | Protection |
|---|---|---|---|
| Accounts, campaigns, content, targets, attempts, audit log | MySQL volume `mysql_data` | **everything business-critical** | nightly verified dump + 7-day binlog (§2) |
| `TOKEN_ENCRYPTION_KEY` | `infra/vps/.env` | every stored OAuth token unreadable | back up **separately from the DB**; no rotation tooling exists yet |
| Queues, delayed jobs, sessions, rate-limit counters | Redis volume `redis_data` (AOF everysec) | users logged out; jobs lost | **reconstructible**: the reconciler rebuilds scheduling jobs from MySQL within ~1–2 min (drilled: total wipe → recovered in 10 s) |
| Uploaded/rendered media | Volume `media_data` (or R2 once configured) | broken asset URLs | back up the volume, or move to R2 (recommended) |
| Certificates | Volume `caddy_data` | re-issued automatically | none needed (keep volume to avoid rate limits) |

Because MySQL is the source of truth and BullMQ is only the executor, **Redis does not need its own backup**.

## 2. Backups

**Take one (drilled):**
```bash
$COMPOSE --profile tools run --rm backup sh /scripts/backup-mysql.sh
# -> $BACKUP_DIR/mysql/socialith-<UTC timestamp>.sql.gz  and  .sha256
```
`mysqldump --single-transaction` gives a consistent snapshot without locking the running app. The script writes a
`.partial` file, then verifies gzip integrity, mysqldump's "Dump completed" marker and a minimum size, and only then
renames it and writes the checksum — a half-written dump is never mistaken for a good one. Files older than
`BACKUP_RETENTION_DAYS` (default 14) are pruned. Typical size on the seed data: 6 KB.

**Schedule it (cron on the host, not drilled):**
```cron
0 3 * * *  cd /opt/socialith && COMPOSE_CMD ... backup sh /scripts/backup-mysql.sh >> /var/log/socialith-backup.log 2>&1
```
(replace `COMPOSE_CMD ...` with the full `docker compose … --profile tools run --rm` line).

**Off-site copy (not implemented, not drilled):** a backup that lives only on the VPS disk is not a backup. Copy
`$BACKUP_DIR/mysql/` nightly to a different provider/region (e.g. rclone or `aws s3 sync --endpoint-url` to R2, with
credentials that can write but not delete). Do this before the first real user.

**Before every update:** take a backup first.

**Point-in-time recovery (not drilled):** binary logging is on with a 7-day window
(`--binlog-expire-logs-seconds=604800`); combined with a dump it allows replaying to a moment between nightly dumps.
Keep a copy of the binlogs off-site if you rely on this, and rehearse it once before you do.

## 3. Restore

**Always drill into a scratch database first — the live database is untouched (drilled):**
```bash
$COMPOSE --profile tools run --rm -e TARGET_DB=socialith_restore_check backup \
    sh /scripts/restore-mysql.sh /backups/mysql/socialith-<timestamp>.sql.gz
# then inspect it, e.g.:  $COMPOSE exec mysql mysql -uroot -p… socialith_restore_check -e "select count(*) from users"
$COMPOSE exec mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "drop database socialith_restore_check"'
```
Do this **monthly** and after any change to the backup scripts; an untested backup is a hope, not a backup.

**Real disaster recovery — destructive, overwrites the live database (drilled: returned exactly to the backup point):**
```bash
$COMPOSE stop api worker                                   # nothing may write during the restore
$COMPOSE --profile tools run --rm -e CONFIRM_RESTORE=yes backup \
    sh /scripts/restore-mysql.sh /backups/mysql/socialith-<timestamp>.sql.gz
$COMPOSE start api worker
sh infra/vps/scripts/smoke-test.sh https://YOUR_DOMAIN
```
Safety rails (all drilled): a **tampered or truncated backup is refused** (checksum, exit 1, nothing created); restoring
over the live database **without `CONFIRM_RESTORE=yes` is refused** (exit 2). After a restore the reconciler re-creates
any scheduling jobs that Redis no longer matches; anything that went overdue during the outage is **held, not
published** (§5).

## 4. Monitoring

There is no monitoring stack yet; these are the signals to wire into one (UptimeRobot/Better Stack/Grafana, etc.) and
what each means.

| Signal | How | Alert when |
|---|---|---|
| **App up** | external check of `https://DOMAIN/api/health` | non-200, or body not `"status":"ok"` (503 = database or Redis down) |
| **Containers healthy** | `$COMPOSE ps` (Status shows `(healthy)`); `docker events` / restart count | any service not healthy, or restarting repeatedly |
| **Worker alive** | container health of `worker` (ready only when all 14 BullMQ workers are connected, including `media-render`) | unhealthy > 2 min |
| **Queue backlog** | `/api/health` → `data.queues[]` (`waiting`, `delayed`, `failed`) | `waiting` growing for > 5 min, or `failed` rising |
| **Certificate** | external check of the HTTPS expiry date | < 14 days (Caddy renews automatically at 30) |
| **Disk** | `df -h` on the host; `docker system df` | > 80 % (mysql, media, backups, binlogs, logs) |
| **MySQL slow queries** | slow log is on (`long_query_time=1`) | sustained entries |
| **Backups** | newest file in `$BACKUP_DIR/mysql/` | older than 26 h |

**Key log lines** (structured JSON; `$COMPOSE logs --since 1h worker | grep …`):

| Log message | Meaning / action |
|---|---|
| `Invalid environment configuration — … not started` | Fatal at boot; `issues[]` names every bad variable. Fix `infra/vps/.env`, `up -d`. |
| `scheduling-reconcile: held stale scheduled content (not published)` | An item missed its slot by more than `SCHEDULE_STALE_AFTER_MINUTES`; a human must decide (§5). |
| `scheduling-reconcile: re-created missing scheduling job` | Redis had lost a job; recovered automatically. Frequent occurrences = investigate Redis. |
| `repeatable schedules were missing while running (Redis state lost?)` | Redis lost its data while the worker was up; self-healed. Find out why (OOM? flush? volume?). |
| `publishing: permanent failure, not retried` | Platform/credential/config problem for that target; see the target's error message. |
| `scheduling-reconcile: failed a target stuck in PUBLISHING past the recovery limit` | Needs manual retry after checking the platform. |

## 5. Held (stale) content — what to do

The system never publishes an item hours after its slot. It is marked `FAILED` with the message *"Missed its scheduled
time (…) by more than N minutes, so it was not published automatically. Review it, then retry the target to publish now."*
and an audit row `SCHEDULE_HELD_STALE` is written.

```sql
-- every held item (read-only)
SELECT c.id, c.caption, c.scheduled_at, a.created_at AS held_at
FROM audit_logs a JOIN content c ON c.id = a.target_id
WHERE a.action = 'SCHEDULE_HELD_STALE' ORDER BY a.created_at DESC;
```
Decide per item: publish now → open the content and **Retry** the target(s) (publishes immediately); no longer wanted →
leave or delete it. *Limitation:* re-scheduling a held item to a new time is not possible through the UI because only
`PENDING` targets are re-scheduled — Retry is the supported path (tracked as technical debt).
Window length: `SCHEDULE_STALE_AFTER_MINUTES` (default 30). Demo/seed accounts can never publish regardless of timing.

## 6. Common incidents

| Symptom | Likely cause | Fix |
|---|---|---|
| Worker restarting; log says `Invalid environment configuration` | missing/localhost `NEXT_PUBLIC_APP_URL`/`API_PUBLIC_URL` (set from `APP_DOMAIN`) or missing secret | correct `infra/vps/.env`, `$COMPOSE up -d` |
| Worker restarting; log says `Worker failed during startup` | Redis/MySQL unreachable | `$COMPOSE ps`; check mysql/redis health and passwords |
| `/api/health` 503 with `database:false` | MySQL down or app-account password wrong | `$COMPOSE logs mysql`; never edit data by hand |
| `/api/health` 503 with `redis:false` | Redis down / wrong password / OOM (`noeviction` refuses writes at 400 MB) | `$COMPOSE logs redis`; raise `maxmemory` only after finding the cause |
| Scheduled posts did not go out | worker was down longer than the stale window → held (§5) | read the audit row; retry the targets deliberately |
| Login works but every user is logged out after a Redis incident | sessions live in Redis | expected; users log in again |
| A render stays "waiting" in Content Studio → Rendering | the worker is down, or another render is using the single render slot (`RENDER_CONCURRENCY`, default 1) | `$COMPOSE ps`; `$COMPOSE logs worker`; a worker that restarts picks the job up again by itself |
| A render fails with `FONT_UNAVAILABLE` | the worker image has no font files in the configured directories | rebuild the worker image (it installs `fonts-dejavu-core` and `fonts-liberation`) or set `FONT_DIRS`; the job can then be retried |
| A render fails with `OUTPUT_INVALID`, `RENDER_FAILED` or `RENDER_TIMEOUT` | FFmpeg problem, a damaged source, or a clip longer than `RENDER_TIMEOUT_MS` (default 15 min) | read the job's detail page (the check table and FFmpeg's last words are stored); retry; raise the timeout only for a known long clip |
| A render fails with `SOURCE_CHANGED` or `SOURCE_MISSING` | the stored source file no longer matches the fingerprint taken when the render was requested | restore the file, or start a new render from the current file |
| Worker disk fills during renders | scratch directories under the worker's temp directory | each job removes its own directory on success, failure and cancel; directories of a killed worker are removed at the next start (older than the stale limit); check `df` and restart the worker |
| Certificate error after a domain change | DNS not pointing at the VPS yet | fix DNS (owner action), `$COMPOSE restart caddy` |
| A natively connected account's publish / status poll / analytics sync fails at the token step (log mentions `pg_advisory_xact_lock` or an unknown function) | TD-59: native OAuth token refresh is PostgreSQL-only and must not be used on MySQL; a native connection should not exist on this stack | do not retry in a loop; disconnect the native account and publish through Upload-Post; see `TD59_REMEDIATION_TASK.md` §2 |

## 7. Secrets and rotation

- `SESSION_SECRET` — rotating logs everyone out; otherwise safe.
- Database/Redis passwords — change in MySQL/Redis first, then `infra/vps/.env`, then `$COMPOSE up -d`.
- **`TOKEN_ENCRYPTION_KEY` — do not rotate casually:** there is no re-encryption tool; changing it makes stored OAuth
  tokens undecryptable (users would have to reconnect every account).
- Never commit `infra/vps/.env`; only `infra/vps/.env.example` (placeholders) is tracked.
