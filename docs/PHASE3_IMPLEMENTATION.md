# Phase 3 — Publishing Center: implementation

Branch `phase3-publishing-center` (base `main` @ `12959f6`, the merged Phase 2). Not merged. Audit and design decisions: `PHASE3_AUDIT.md`. Rules: `PUBLISHING_WORKFLOW.md`. Operations: `PUBLISHING_OPERATIONS.md`. Tests: `PUBLISHING_TESTING.md`.

## 1. What was built

An approval-to-publication workflow and a dashboard on top of the **existing** publishing engine (BullMQ content-scheduling → publishing → status poll, the Upload-Post provider, the ownership guards, the reconciler). Nothing was re-created; the engine was made *target-aware* and gated by approval.

| Area | Outcome |
|---|---|
| Approval workflow | per-destination DRAFT → READY_FOR_REVIEW → APPROVED (+ REJECTED), approver identity, timestamps, rejection reason, append-only history, content revisions, audit log; approval pinned to the exact payload reviewed |
| Lifecycle | the 12 states of the brief derived from stored columns; no existing enum value changed |
| Scheduling | per-target times on the one existing job per content; per-target stale hold; reschedule / unschedule / hold / release / cancel / reopen / retry; automatic scheduling after approval (campaign over organization) |
| Hybrid ownership | unchanged guards, now per target; hand-off by the target's own time; edits/cancels reach the provider within seconds |
| Validation | per-platform rules before scheduling, structured actionable errors, daily cap + spacing in the organization's timezone, repetitive-distribution guard, music + rights rules, "require the track" |
| Dashboard | 9 sections + publication detail + new-publication form, existing design system |
| Reporting | publication detail page with every requested field + attempts + history; list/queue/scheduled/failed views with filters |

## 2. Data model (migration `20261120200000_publishing_center`, purely additive, verified on a fresh MySQL 8.4 with no drift)

- `content_targets` + `approval_status`, `exception` (HELD/CANCELLED/STALE), `caption_override`, `title_override`, `require_music`, `approved_payload`, `submitted_by_id/at`, `approved_by_id/at`, `scheduled_timezone`, index `(approval_status, status)`. Existing rows read as DRAFT.
- `publication_events` (append-only history), `content_revisions`, `publishing_settings` (one row per organization, created lazily), `campaigns.auto_schedule_on_approval` (nullable = inherit).
- Rollback: the new columns/tables are unused by `main`; reverting the application code leaves them dormant (nothing reads them), and nothing was dropped, renamed or rewritten.

## 3. Code map

| Layer | Files |
|---|---|
| Pure rules (new package `@socialith/publishing`, no I/O, shared by API, worker, web) | `state.ts` (lifecycle, allowed actions) · `validation.ts` (platform rules) · `similarity.ts` (repetition guard) · `payload.ts` (canonical approval payload, `buildTargetPayload`) · `content-rollup.ts` · `timezone.ts` |
| Worker (existing engine, extended) | `processors/content-scheduling.processor.ts` (target-aware, approval gate, `moveToDelayed`) · `scheduling/{hold,reconcile,rollup}.ts` · `publishing/{approval-gate,finalize}.ts` · `processors/publishing.processor.ts` (gate, per-destination text) · `upload-post/{sweep,publish}.ts` (target time, gate, required track, unknown outcome on unreadable answers) |
| API | `services/publishing-{common,validation.service,workflow.service,read.service,settings.service}.ts` · `controllers/publishing.controller.ts` · `routes/publishing.ts` · `validation/publishing.validation.ts` · content-target repository/service (approval gate and per-target times for the older scheduling path) · `lib/queue.ts`, `lib/upload-post.ts` (remove job, on-demand sweep) |
| Web | `app/(app)/publishing/**` (layout, overview, calendar, queue, publications + detail, scheduled, failed, accounts, approvals, settings, new) · `lib/publishing.tsx` |

## 4. API (all under `/api/publishing`; read = any role, prepare/operate = EDITOR, approve/reject/settings = ADMIN)

`GET overview · calendar · destinations · settings · campaigns · publications · publications/:id` — `PUT settings · campaigns/:id` — `POST publications` — `PATCH publications/:id` — `POST publications/:id/{validate,submit,withdraw,approve,reject,schedule,unschedule,hold,release,cancel,reopen,retry}`.
Refusals: `409` illegal transition / changed concurrently / provider about to run it; `422 VALIDATION_FAILED` with `error.details.issues[]`; `404` for another organization's ids. There is no bulk-approval endpoint.

## 5. Behaviour changes to existing code (all backward compatible, each covered by a test)

1. `/content/:id/schedule` and publish-now: when the organization requires approval only APPROVED destinations are scheduled (none → 409); targets already SCHEDULED now move to the new time (before, a content-level reschedule left them behind); HELD/CANCELLED targets are never re-scheduled by the bulk path. Organizations without settings: unchanged.
2. The scheduling job, stale hold, reconciler and Upload-Post sweep use each target's own `scheduledAt`; with identical target times (everything scheduled before Phase 3) behaviour is identical — the Phase 1/2 suites pass unchanged except one fixture helper that now moves a content's *and* its targets' times, as a real reschedule does.
3. A stale hold now marks FAILED **+ STALE** (explicit state) and no longer fails siblings that are not stale.
4. Held/cancelled targets no longer keep a content open (finalize, reconciler roll-up).
5. An unreadable HTTP 200 answer to a publish is `UNKNOWN_OUTCOME` (was: row left `PENDING`).
6. Publishing uses the destination's own caption/title when set (same rule as the approval payload).
7. `@socialith/types`: optional `details` on the error envelope + `VALIDATION_FAILED`; web `ApiError` carries `details`; web client gains `apiPut`.

## 6. Configuration

No new environment variable. Behaviour is configured per organization in *Publishing Settings* (stored in `publishing_settings`). Hand-off stays under the Phase 2 variables (`UPLOAD_POST_SCHEDULE_HANDOFF_ENABLED` default false).

## 7. Decisions that need the owner (also in the report)

1. **Approval default** for organizations that never saved settings (kept *off* for compatibility; recommended on) — TD-51.
2. **"Artist"** is the free-text `Sound.artist` until Phase 7 — TD-47.
3. **Interpretation** of "the previously selected automatic publishing model" = Socialith's database owns the schedule, Upload-Post may execute after an optional bounded hand-off (off by default), human approval before publishing, automatic scheduling only at a person's planned time. Say so if you meant otherwise.
4. **Self-approval** allowed by default so a one-person agency can operate (switchable).
5. **Platform thresholds** (duration, size, aspect) are assumptions until the first live tests — TD-50.

## 8. Not done / out of scope

Real publication of any kind; Page Network, AI Studio, the Artist/Music/Campaign model, creator portal, analytics; drag-and-drop calendar and automated browser tests (TD-52); FFmpeg probing of media facts (TD-49); Page Group / category filters (TD-48).
