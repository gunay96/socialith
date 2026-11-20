# Socialith — live operations architecture

Status: **design document, nothing here is implemented.** It defines where real-time operational data comes from and how the interface (`SOCIALITH_UX_DESIGN_SYSTEM.md`) may show it, for Phase 5 and later. Facts about "today" were read from the code at `110e637`+.

**Core rule (binding):** progress is derived from real backend data — persisted job rows and queue state. A percentage is never invented, estimated or smoothed; when progress cannot be measured the interface shows an indeterminate animation with real timestamps (`SOCIALITH_UX_DESIGN_SYSTEM.md` §6.1).

## 1. Goals

| Goal | Meaning |
|---|---|
| One operations picture | health, queues, running jobs and problems in one read-only view |
| Truthful progress | every bar traceable to a database row or a queue counter |
| Actionable failures | every failure carries its real code and a remedy |
| No second source of truth | the database remains the master; Redis/BullMQ state is read, never trusted over the database |
| Cheap | one aggregated read, cached for a few seconds, never a query per widget |

## 2. What the backend can measure today

| Pipeline | Real data available now | Measurable progress today |
|---|---|---|
| **Publishing** | `ContentTarget.status` (PENDING/SCHEDULED/PUBLISHING/PUBLISHED/FAILED) plus approval and exception columns (12 derived states, `@socialith/publishing`); `PublishAttempt` rows (attempt number, status, error code, timings); `UploadPostPublication` (mode, provider status, request id); `PublicationEvent` history | **determinate** counts ("x of y destinations published", targets per state); stage from real state; a provider upload in flight has **no** percentage |
| **Media processing** | `VideoRenderJob`: status, attempts, `startedAt`, `completedAt`, error code/message, result asset. Asset `sizeBytes` only; duration/dimensions not extracted (TD-49) | stage + elapsed time; **no percentage** (FFmpeg progress is not recorded) |
| **AI generation** | `ContentGenerationJob`: status, attempts, timings, error code/message, token usage and cost after completion | stage + elapsed time; batch "n of m candidates" is determinate once batches exist |
| **Upload-Post sync** | `UploadPostSyncRun`: trigger, status, started/finished, counts seen/created/updated/removed, plan, error kind | counters grow while RUNNING but the total is unknown until it ends → indeterminate with live counters |
| **Scheduling** | content-scheduling queue (delayed jobs), per-target `scheduledAt`, hold/stale events | "next in 12 min" from real timestamps |
| **Queues** | `getQueueHealth()`: waiting / active / delayed / failed for scheduling, generation, render, publishing, analytics-sync | counts; trend only from counts sampled over time |
| **Health** | API `GET /api/health`: database, Redis, queue counts. Worker `GET /health` on its own port: ready only when every queue worker is connected | up/down; **the dashboard cannot see worker liveness today** (§5) |
| **Job progress inside the worker** | none: no processor reports progress (`job.updateProgress` is not used anywhere) | — |

Everything not in the "measurable" column stays indeterminate until the prerequisite below exists.

## 3. Operations overview — read model

One endpoint, `GET /api/operations/overview` *(proposal)*, organization-scoped, read-only, any authenticated role (like the other overviews). It assembles existing numbers; it creates no new state.

```
{
  generatedAt,
  health:   { api, database, redis, workers: { state, lastHeartbeatAt, instances } },
  queues:   [{ name, waiting, active, delayed, failed, oldestWaitingSince? }],
  running:  [{ kind, id, label, stage, startedAt, progress: { mode: "determinate", done, total } | { mode: "indeterminate" } }],
  attention:[{ kind, id, title, code, remedy: { text, href? } }],
  today:    { scheduled, published, failed }
}
```

`progress.mode` is decided **only** by the server: it emits `determinate` solely when it holds both `done` and `total` from real rows, otherwise `indeterminate`. The client never computes a percentage from anything else and never promotes an indeterminate item.

Organization isolation: every query is scoped by `organizationId`; queue counts are system-wide, so they are shown to OWNER/ADMIN only and omitted otherwise (a queue contains other organizations' work).

## 4. Per-pipeline contract

### 4.1 Publishing queue
- **Source of truth:** database rows. BullMQ is the transport; the existing reconciler already repairs queue/database drift, so the interface reads the database for state and BullMQ only for depth.
- **Display:** per content "x of y published" (determinate); per publication the stored state; queue depth per queue; the Phase 3 stale/held reasons verbatim.
- **No percentage** for a single publication; stages only.

### 4.2 Campaign workflow
Counts of the campaign's content/targets grouped by the derived publication states, mapped to the stepper in `SOCIALITH_UX_DESIGN_SYSTEM.md` §7.1. Pure SQL aggregation over existing tables; no new storage.

### 4.3 Media processing (Phase 5 prerequisites for a real percentage)
1. Probe duration/dimensions with ffprobe at upload and on render, store on the asset (closes TD-49).
2. The render worker persists progress as **measured output time ÷ known duration** (FFmpeg's `-progress` stream) in a column such as `progress_done_ms` / `progress_total_ms` on the job row — two real numbers, not a stored percentage.
3. The API reports `determinate` only when `progress_total_ms` is known and `progress_done_ms` is fresh (updated within a few seconds); otherwise indeterminate.
Until then: stage + elapsed time.

### 4.4 AI generation (Phase 6)
The provider gives no percentage, so a single generation is indeterminate with elapsed time. A batch uses `candidates_done / candidates_requested` from finished rows. Cost and tokens appear after completion only, from the provider's own usage data (already stored in `usageMetadata`).

### 4.5 Upload-Post
In-flight provider requests: indeterminate, with `request_id` available in the detail view. The status poll's real outcome (completed / failed / unknown outcome) replaces the animation; an unknown outcome is shown as such, never as success.

## 5. Worker and Redis health

| Signal | Source | Gap and proposal |
|---|---|---|
| Database | API `SELECT 1` | exists |
| Redis | API `PING` | exists |
| Queue backlog | `getJobCounts` per queue | exists; add `oldestWaitingSince` (age of the oldest waiting job) so "stuck" is visible, not just "n waiting" |
| Worker readiness | worker `/health` on `WORKER_PORT`, 200 only when every queue worker is connected | **not reachable from the API or the dashboard** |
| Worker liveness | — | *(proposal)* each worker process writes `socialith:worker:heartbeat:<instance>` to Redis every 10 s with a 30 s TTL, value = `{ startedAt, readyQueues, version }`. The overview reads those keys: ≥ 1 live key = workers up; none = **down**; the list gives the instance count. A key is evidence of a recent heartbeat, nothing more. |

States shown: **ok** (all of the above healthy), **degraded** (Redis up but no worker heartbeat, or one dependency failing), **down**. "Redis not configured" (the demo-lite tier) is shown as *not configured*, not as a failure — the existing `/api/health` already distinguishes it.

Alerts: only thresholds on real values (no worker heartbeat for > 60 s; oldest waiting job older than the stale window; failed count rising), each with its remedy from the runbook (`OPERATIONS_RUNBOOK.md` §6).

## 6. Delivery to the browser

| Option | Verdict |
|---|---|
| **Polling one aggregated endpoint every 5-10 s, with `ETag`/`If-None-Match`** (and a visibility pause when the tab is hidden) | **Recommended first**: simplest, works behind Caddy/Cloudflare, no new infrastructure, naturally stateless; fits the scale (a handful of operators) |
| Server-Sent Events | a later optimization if polling load or latency becomes a problem; the payload would be the same overview, pushed on change |
| WebSockets | not needed: the traffic is one-way |

Whatever the transport, the UI rules are the same: show *Updated Ns ago*, mark data **stale** after twice the interval, dim rather than hide stale numbers, never animate between polls without new data.

Caching: the overview is cached server-side for ~3 s per organization so many open dashboards cost one query set.

## 7. Errors

The overview's `attention` items and every job failure reuse the existing structured errors: `ERROR_CODES` plus `details`, and the runbook vocabulary (`PUBLISHING_OPERATIONS.md`, `UPLOAD_POST_SETUP.md`). Each item carries `code`, a plain-language `title`, and `remedy` (`text`, optional deep link such as the account to reconnect). A job failure without a known remedy says so and names who to contact; the interface never invents a cause.

## 8. Security and privacy

Read-only; organization-scoped; no secrets, tokens or provider payloads in any field; job error messages are the already-sanitized `errorMessage` values; queue-level numbers admin-only (§3); no creator data (Phase 4 rule). Heartbeat keys contain no credentials.

## 9. Phasing *(proposal, owner decides)*

| Phase | Adds | Needs |
|---|---|---|
| 5 | Operations overview v1 (health, queue depth, publishing counts, campaign stepper), worker heartbeat, ffprobe + media job progress columns | this document + owner approval |
| 6 | AI generation job views, batch progress | Phase 5 overview |
| later | SSE if polling proves insufficient; alert delivery (e-mail/webhook) | owner decision |

Not designed here: production monitoring/alerting stack (TD-35), analytics dashboards (Phase 9).

## 10. Testing approach (when built)

Unit: the rule "determinate only when both numbers are real" as a pure function with a table of cases (missing total, stale counter, terminal states). Integration (MySQL + Redis): the overview against seeded jobs in every state, including a dead worker (no heartbeat), a failing job, and an empty organization; organization isolation. Browser: stale chip after a stopped API, reduced-motion behavior, indeterminate bar without `aria-valuenow`. The progress rule is also asserted negatively: no response ever carries a percentage that is not `done/total` of real rows.
