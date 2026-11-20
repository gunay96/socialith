import { prisma } from "@socialith/database";
import type { Prisma } from "@socialith/database";
import { ERROR_CODES } from "@socialith/types";
import {
  STATE_LABELS,
  allowedActions,
  isValidTimeZone,
  payloadMatchesApproval,
  type PublicationAction,
  type PublicationState,
  type ValidationIssue,
} from "@socialith/publishing";
import { ApiHttpError } from "../middleware/error-handler.js";
import { createAuditLog, type AuditAction } from "../repositories/audit-log.repository.js";
import { enqueuePublishingJob } from "../lib/queue.js";
import { enqueueUploadPostSweep } from "../lib/upload-post.js";
import type { SafeUser } from "../types/auth.js";
import {
  PUBLICATION_INCLUDE,
  armContentScheduling,
  getEffectiveSettings,
  isProviderOwned,
  payloadOf,
  recordEvent,
  rollUpContent,
  stateOf,
  toPublicationDto,
  type EffectiveSettings,
  type Publication,
} from "./publishing-common.js";
import { validatePublicationTarget } from "./publishing-validation.service.js";

/** A provider job this close to its run time can no longer be edited or cancelled (Upload-Post answers 409 within ~60 s). */
const PROVIDER_LOCK_MS = 120_000;

type Tx = Prisma.TransactionClient;

// ------------------------------------------------------------------------------------------------ helpers

export async function loadPublication(actor: SafeUser, id: string, db: Tx | typeof prisma = prisma): Promise<Publication> {
  const t = await db.contentTarget.findFirst({ where: { id, content: { organizationId: actor.organizationId } }, include: PUBLICATION_INCLUDE });
  if (!t) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Publication not found."); // another organization's id is a 404, never a 403
  return t;
}

const isAdmin = (actor: SafeUser) => actor.role === "ADMIN" || actor.role === "OWNER";

function assertAllowed(t: Publication, action: PublicationAction, settings: EffectiveSettings): PublicationState {
  const state = stateOf(t);
  if (!allowedActions(state, settings.requireApproval).includes(action)) {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, `Cannot ${action.toLowerCase().replace("_", " ")} a publication that is ${STATE_LABELS[state].toLowerCase()}.`);
  }
  return state;
}

/** Compare-and-set against the state the decision was made on; a concurrent change makes this fail instead of overwriting it. */
async function casUpdate(tx: Tx, t: Publication, data: Prisma.ContentTargetUncheckedUpdateManyInput): Promise<void> {
  const r = await tx.contentTarget.updateMany({
    where: { id: t.id, status: t.status, approvalStatus: t.approvalStatus, exception: t.exception },
    data,
  });
  if (r.count !== 1) throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "This publication was changed by someone else a moment ago. Reload it and try again.");
}

function validationError(issues: ValidationIssue[], what: string): ApiHttpError {
  const errors = issues.filter((i) => i.severity === "ERROR");
  const first = errors[0]?.message ?? "validation failed";
  return new ApiHttpError(422, ERROR_CODES.VALIDATION_FAILED, `${what}: ${first}${errors.length > 1 ? ` (and ${errors.length - 1} more problem${errors.length === 2 ? "" : "s"})` : ""}`, { issues });
}

function audit(actor: SafeUser | null, t: Publication, action: AuditAction, metadata: Record<string, unknown> = {}) {
  return createAuditLog({ organizationId: t.content.organizationId, userId: actor?.id ?? null, action, targetType: "ContentTarget", targetId: t.id, metadata: { contentId: t.contentId, platform: t.socialAccount.platform, ...metadata } });
}

/** One ContentRevision per distinct snapshot of the content a reviewer is shown (no new row when nothing changed). */
async function ensureRevision(tx: Tx, t: Publication, actor: SafeUser, reason: string): Promise<number> {
  const snapshot = {
    caption: t.content.caption,
    soundId: t.content.soundId,
    variations: t.content.variations.map((v) => ({ platform: v.platform, title: v.title, caption: v.caption })).sort((a, b) => a.platform.localeCompare(b.platform)),
    assets: t.content.assets.map((a) => ({ id: a.id, type: a.type, platform: a.platform })),
  };
  const latest = await tx.contentRevision.findFirst({ where: { contentId: t.contentId }, orderBy: { revision: "desc" } });
  if (latest && JSON.stringify(latest.snapshot) === JSON.stringify(snapshot)) return latest.revision;
  const created = await tx.contentRevision.create({
    data: { contentId: t.contentId, revision: (latest?.revision ?? 0) + 1, snapshot: snapshot as Prisma.InputJsonValue, reason, createdById: actor.id },
  });
  return created.revision;
}

function parseInstant(value: string | Date): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "scheduledAt is not a valid date and time.");
  return d;
}

function zoneOrDefault(tz: string | undefined, settings: EffectiveSettings): string {
  if (!tz) return settings.timezone;
  if (!isValidTimeZone(tz)) throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, `"${tz}" is not a valid IANA timezone.`);
  return tz;
}

async function afterChange(t: Publication, opts: { providerRelevant: boolean }): Promise<void> {
  await armContentScheduling(t.contentId);
  if (opts.providerRelevant) await enqueueUploadPostSweep().catch(() => undefined); // best effort: the repeatable sweep does the same a minute later
}

const providerRelevant = (t: Publication) => t.socialAccount.publishingProvider === "UPLOAD_POST" || t.uploadPostPublication !== null;

function assertProviderNotLocked(t: Publication, now: Date): void {
  if (isProviderOwned(t) && t.scheduledAt && t.scheduledAt.getTime() - now.getTime() < PROVIDER_LOCK_MS) {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "Upload-Post is about to run this scheduled post (it can no longer be edited or cancelled at the provider). Wait for the result.");
  }
}

// ------------------------------------------------------------------------------------------------ create / edit

export interface CreateDestinationInput {
  socialAccountId: string;
  captionOverride?: string | null;
  titleOverride?: string | null;
  requireMusic?: boolean;
  scheduledAt?: string | null;
  timezone?: string;
}

export async function createPublications(actor: SafeUser, input: { contentId: string; destinations: CreateDestinationInput[] }) {
  const content = await prisma.content.findFirst({ where: { id: input.contentId, organizationId: actor.organizationId }, select: { id: true } });
  if (!content) throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, "Content not found.");
  const settings = await getEffectiveSettings(actor.organizationId);

  const created: Publication[] = [];
  const skipped: { socialAccountId: string; reason: string }[] = [];
  for (const d of input.destinations) {
    const account = await prisma.socialAccount.findFirst({ where: { id: d.socialAccountId, organizationId: actor.organizationId }, select: { id: true } });
    if (!account) {
      skipped.push({ socialAccountId: d.socialAccountId, reason: "Destination not found in this organization." });
      continue;
    }
    const plannedAt = d.scheduledAt ? parseInstant(d.scheduledAt) : null;
    const tz = zoneOrDefault(d.timezone, settings);
    try {
      const row = await prisma.$transaction(async (tx) => {
        const target = await tx.contentTarget.create({
          data: {
            contentId: content.id,
            socialAccountId: account.id,
            captionOverride: d.captionOverride?.trim() ? d.captionOverride : null,
            titleOverride: d.titleOverride?.trim() ? d.titleOverride.trim() : null,
            requireMusic: d.requireMusic ?? false,
            scheduledAt: plannedAt,
            scheduledTimezone: plannedAt ? tz : null,
          },
          include: PUBLICATION_INCLUDE,
        });
        await recordEvent(tx, { organizationId: actor.organizationId, contentTargetId: target.id, type: "CREATED", toState: "DRAFT", actorId: actor.id, metadata: { plannedAt: plannedAt?.toISOString() ?? null } });
        return target;
      });
      created.push(row);
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") skipped.push({ socialAccountId: d.socialAccountId, reason: "This content already has a publication for that destination. Open it instead of creating another." });
      else throw err;
    }
  }
  if (created.length) {
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PUBLICATION_CREATED", targetType: "Content", targetId: content.id, metadata: { count: created.length } });
  }
  const now = new Date();
  const items = [];
  for (const t of created) {
    const v = await validatePublicationTarget(t, { settings, now, scheduledAt: t.scheduledAt, scheduleRequired: false });
    items.push({ publication: toPublicationDto(t, settings.requireApproval), validation: v });
  }
  return { created: items, skipped };
}

export interface UpdatePublicationInput {
  captionOverride?: string | null;
  titleOverride?: string | null;
  requireMusic?: boolean;
  scheduledAt?: string | null;
  timezone?: string;
}

export async function updatePublication(actor: SafeUser, id: string, patch: UpdatePublicationInput) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  const state = assertAllowed(t, "EDIT", settings);

  const next = {
    captionOverride: patch.captionOverride === undefined ? t.captionOverride : patch.captionOverride?.trim() ? patch.captionOverride : null,
    titleOverride: patch.titleOverride === undefined ? t.titleOverride : patch.titleOverride?.trim() ? patch.titleOverride.trim() : null,
    requireMusic: patch.requireMusic ?? t.requireMusic,
  };
  const plannedAt = patch.scheduledAt === undefined ? t.scheduledAt : patch.scheduledAt === null ? null : parseInstant(patch.scheduledAt);
  const tz = patch.scheduledAt === undefined && !patch.timezone ? t.scheduledTimezone : plannedAt ? zoneOrDefault(patch.timezone ?? t.scheduledTimezone ?? undefined, settings) : null;

  // What would be published after this edit — if it differs from what was reviewed, the review no longer counts.
  const payloadChanged = payloadOf({ ...t, captionOverride: next.captionOverride, titleOverride: next.titleOverride }) !== payloadOf(t);
  const invalidate = payloadChanged && (t.approvalStatus === "READY_FOR_REVIEW" || t.approvalStatus === "APPROVED");

  await prisma.$transaction(async (tx) => {
    await casUpdate(tx, t, {
      ...next,
      scheduledAt: plannedAt,
      scheduledTimezone: tz,
      ...(invalidate ? { approvalStatus: "DRAFT", approvedPayload: null, approvedById: null, approvedAt: null, submittedAt: null, submittedById: null } : {}),
    });
    await recordEvent(tx, {
      organizationId: actor.organizationId,
      contentTargetId: t.id,
      type: "EDITED",
      fromState: state,
      toState: invalidate ? "DRAFT" : state,
      actorId: actor.id,
      metadata: { fields: Object.keys(patch), payloadChanged },
    });
    if (invalidate) {
      await recordEvent(tx, { organizationId: actor.organizationId, contentTargetId: t.id, type: "INVALIDATED", fromState: state, toState: "DRAFT", actorId: actor.id, reason: "The text was edited after it was submitted/approved, so the review no longer applies." });
    }
  });
  return toPublicationDto(await loadPublication(actor, id), settings.requireApproval);
}

// ------------------------------------------------------------------------------------------------ approval workflow

export async function submitPublication(actor: SafeUser, id: string) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  const state = assertAllowed(t, "SUBMIT", settings);

  // Review is about the CONTENT (account, media, text, track, repetition). The time, daily cap and spacing are checked when
  // the publication is scheduled, so a plan that has since gone stale never blocks a review.
  const v = await validatePublicationTarget(t, { settings, now: new Date(), scheduledAt: null, scheduleRequired: false });
  if (!v.ok) throw validationError(v.issues, "It cannot be submitted for review yet");

  const revision = await prisma.$transaction(async (tx) => {
    const rev = await ensureRevision(tx, t, actor, "submitted for review");
    await casUpdate(tx, t, { approvalStatus: "READY_FOR_REVIEW", submittedById: actor.id, submittedAt: new Date(), approvedPayload: null, approvedById: null, approvedAt: null });
    await recordEvent(tx, { organizationId: actor.organizationId, contentTargetId: t.id, type: "SUBMITTED", fromState: state, toState: "READY_FOR_REVIEW", actorId: actor.id, metadata: { revision: rev, warnings: v.issues.filter((i) => i.severity === "WARNING").map((i) => i.code) } });
    return rev;
  });
  await audit(actor, t, "PUBLICATION_SUBMITTED", { revision });
  return { publication: toPublicationDto(await loadPublication(actor, id), settings.requireApproval), validation: v };
}

export async function withdrawPublication(actor: SafeUser, id: string) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  const state = assertAllowed(t, "WITHDRAW", settings);
  if (t.submittedById !== actor.id && !isAdmin(actor)) throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, "Only the person who submitted it, or an admin, can withdraw it.");
  await prisma.$transaction(async (tx) => {
    await casUpdate(tx, t, { approvalStatus: "DRAFT", submittedAt: null, submittedById: null });
    await recordEvent(tx, { organizationId: actor.organizationId, contentTargetId: t.id, type: "WITHDRAWN", fromState: state, toState: "DRAFT", actorId: actor.id });
  });
  return toPublicationDto(await loadPublication(actor, id), settings.requireApproval);
}

export async function approvePublication(actor: SafeUser, id: string, note?: string | null) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  const state = assertAllowed(t, "APPROVE", settings);
  if (!settings.allowSelfApproval && t.submittedById === actor.id) {
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, "Self-approval is switched off in Publishing Settings: a different admin must approve what you submitted.");
  }

  // The approver sees (and is held to) the same platform validation, so nothing unpublishable is approved.
  const v = await validatePublicationTarget(t, { settings, now: new Date(), scheduledAt: null, scheduleRequired: false });
  if (!v.ok) throw validationError(v.issues, "It cannot be approved yet");

  const payload = payloadOf(t);
  await prisma.$transaction(async (tx) => {
    await casUpdate(tx, t, { approvalStatus: "APPROVED", approvedPayload: payload, approvedById: actor.id, approvedAt: new Date() });
    await recordEvent(tx, { organizationId: actor.organizationId, contentTargetId: t.id, type: "APPROVED", fromState: state, toState: "APPROVED", actorId: actor.id, reason: note ?? null });
  });
  await audit(actor, t, "PUBLICATION_APPROVED", { note: note ?? null });

  // Automatic scheduling after approval (campaign setting, else organization setting): only at the time a person already
  // planned for this publication — never an invented time — and only if it passes the same scheduling validation.
  const auto = t.content.campaign?.autoScheduleOnApproval ?? settings.autoScheduleOnApproval;
  let autoScheduled = false;
  let autoScheduleIssues: ValidationIssue[] = [];
  if (auto && t.scheduledAt) {
    try {
      await scheduleInternal(actor, await loadPublication(actor, id), t.scheduledAt, t.scheduledTimezone ?? settings.timezone, "AUTO_SCHEDULED", settings);
      autoScheduled = true;
    } catch (err) {
      if (err instanceof ApiHttpError && err.code === ERROR_CODES.VALIDATION_FAILED) autoScheduleIssues = ((err.details as { issues?: ValidationIssue[] } | undefined)?.issues ?? []).filter((i) => i.severity === "ERROR");
      else if (!(err instanceof ApiHttpError)) throw err;
    }
  }
  return { publication: toPublicationDto(await loadPublication(actor, id), settings.requireApproval), autoScheduled, autoScheduleIssues, validation: v };
}

export async function rejectPublication(actor: SafeUser, id: string, reason: string) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  const state = assertAllowed(t, "REJECT", settings);
  await prisma.$transaction(async (tx) => {
    await casUpdate(tx, t, { approvalStatus: "REJECTED", approvedPayload: null, approvedById: null, approvedAt: null });
    await recordEvent(tx, { organizationId: actor.organizationId, contentTargetId: t.id, type: "REJECTED", fromState: state, toState: "REJECTED", actorId: actor.id, reason });
  });
  await audit(actor, t, "PUBLICATION_REJECTED", { reason });
  return toPublicationDto(await loadPublication(actor, id), settings.requireApproval);
}

// ------------------------------------------------------------------------------------------------ scheduling

type ScheduleKind = "SCHEDULED" | "RESCHEDULED" | "AUTO_SCHEDULED" | "RELEASED";

/**
 * The single place a publication becomes SCHEDULED. Order matters:
 *  1. the approval gate (approved AND unchanged since approval) — a stale approval is invalidated, not honoured;
 *  2. platform validation incl. time validity, caps and repetition — every problem reported at once;
 *  3. one compare-and-set transaction (target + content roll-up + event), then the BullMQ job and the provider sweep.
 * The scheduling owner stays Socialith; the existing Upload-Post sweep may hand the target to the provider's
 * scheduler inside its window (and edits/cancels it there when this changes).
 */
async function scheduleInternal(actor: SafeUser, t: Publication, at: Date, tz: string, kind: ScheduleKind, settings: EffectiveSettings) {
  const now = new Date();
  const state = stateOf(t);
  assertProviderNotLocked(t, now);

  if (settings.requireApproval) {
    if (t.approvalStatus !== "APPROVED") throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "This publication has not been approved. Submit it for review and have it approved before scheduling.");
    if (!payloadMatchesApproval(t.approvedPayload, payloadOf(t))) {
      // A publication that is already SCHEDULED goes back to the plan state with its approval: it must not stay scheduled
      // on an approval that no longer applies (the worker's gate would hold it anyway; the database says so honestly).
      const wasScheduled = t.status === "SCHEDULED";
      await prisma.$transaction(async (tx) => {
        await casUpdate(tx, t, { approvalStatus: "DRAFT", approvedPayload: null, approvedById: null, approvedAt: null, ...(wasScheduled ? { status: "PENDING" } : {}) });
        if (wasScheduled) await rollUpContent(tx, t.contentId);
        await recordEvent(tx, { organizationId: actor.organizationId, contentTargetId: t.id, type: "INVALIDATED", fromState: state, toState: "DRAFT", actorId: actor.id, reason: "The content changed after it was approved." });
      });
      if (wasScheduled) await afterChange(t, { providerRelevant: providerRelevant(t) });
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "The content changed after it was approved, so the approval was withdrawn. Review it and approve it again.");
    }
  }

  const v = await validatePublicationTarget(t, { settings, now, scheduledAt: at, scheduleRequired: true });
  if (!v.ok) throw validationError(v.issues, "It cannot be scheduled");

  const previous = t.scheduledAt;
  await prisma.$transaction(async (tx) => {
    await casUpdate(tx, t, { status: "SCHEDULED", scheduledAt: at, scheduledTimezone: tz, exception: null, errorMessage: null });
    await rollUpContent(tx, t.contentId);
    await recordEvent(tx, {
      organizationId: actor.organizationId,
      contentTargetId: t.id,
      type: kind === "AUTO_SCHEDULED" ? "AUTO_SCHEDULED" : kind === "RELEASED" ? "RELEASED" : kind === "RESCHEDULED" ? "RESCHEDULED" : "SCHEDULED",
      fromState: state,
      toState: "SCHEDULED",
      actorId: actor.id,
      metadata: { from: previous?.toISOString() ?? null, to: at.toISOString(), timezone: tz, warnings: v.issues.filter((i) => i.severity === "WARNING").map((i) => i.code) },
    });
  });
  await afterChange(t, { providerRelevant: providerRelevant(t) });
  await audit(actor, t, kind === "RESCHEDULED" ? "PUBLICATION_RESCHEDULED" : "PUBLICATION_SCHEDULED", { at: at.toISOString(), timezone: tz, kind });
  return v;
}

export async function schedulePublication(actor: SafeUser, id: string, input: { scheduledAt: string; timezone?: string }) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  const state = stateOf(t);
  const actions = allowedActions(state, settings.requireApproval);
  const reschedule = actions.includes("RESCHEDULE");
  if (!reschedule && !actions.includes("SCHEDULE")) assertAllowed(t, "SCHEDULE", settings); // throws the standard message
  const validation = await scheduleInternal(actor, t, parseInstant(input.scheduledAt), zoneOrDefault(input.timezone, settings), reschedule ? "RESCHEDULED" : "SCHEDULED", settings);
  return { publication: toPublicationDto(await loadPublication(actor, id), settings.requireApproval), validation };
}

export async function releasePublication(actor: SafeUser, id: string) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  assertAllowed(t, "RELEASE", settings);
  if (!t.scheduledAt || t.scheduledAt.getTime() - Date.now() < settings.minLeadMinutes * 60_000) {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "Its scheduled time has passed (or is too close). Choose a new time with Reschedule instead of releasing it.");
  }
  const validation = await scheduleInternal(actor, t, t.scheduledAt, t.scheduledTimezone ?? settings.timezone, "RELEASED", settings);
  return { publication: toPublicationDto(await loadPublication(actor, id), settings.requireApproval), validation };
}

async function park(actor: SafeUser, id: string, action: "UNSCHEDULE" | "HOLD" | "CANCEL", reason: string | null) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  const state = assertAllowed(t, action, settings);
  assertProviderNotLocked(t, new Date());

  const data: Prisma.ContentTargetUncheckedUpdateManyInput =
    action === "UNSCHEDULE"
      ? { status: "PENDING", exception: null }
      : action === "HOLD"
        ? { status: "PENDING", exception: "HELD" }
        : { status: "PENDING", exception: "CANCELLED", errorMessage: t.status === "FAILED" ? t.errorMessage : null };
  const type = action === "UNSCHEDULE" ? "UNSCHEDULED" : action === "HOLD" ? "HELD" : "CANCELLED";
  const toState: PublicationState = action === "HOLD" ? "HELD" : action === "CANCEL" ? "CANCELLED" : t.approvalStatus === "APPROVED" ? "APPROVED" : (t.approvalStatus as PublicationState);

  await prisma.$transaction(async (tx) => {
    await casUpdate(tx, t, data);
    await rollUpContent(tx, t.contentId);
    await recordEvent(tx, { organizationId: actor.organizationId, contentTargetId: t.id, type, fromState: state, toState, actorId: actor.id, reason, metadata: { scheduledAt: t.scheduledAt?.toISOString() ?? null } });
  });
  await afterChange(t, { providerRelevant: providerRelevant(t) });
  if (action === "CANCEL") await audit(actor, t, "PUBLICATION_CANCELLED", { reason });
  return toPublicationDto(await loadPublication(actor, id), settings.requireApproval);
}

export const unschedulePublication = (actor: SafeUser, id: string) => park(actor, id, "UNSCHEDULE", null);
export const holdPublication = (actor: SafeUser, id: string, reason: string | null) => park(actor, id, "HOLD", reason);
export const cancelPublication = (actor: SafeUser, id: string, reason: string | null) => park(actor, id, "CANCEL", reason);

export async function reopenPublication(actor: SafeUser, id: string) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  const state = assertAllowed(t, "REOPEN", settings);
  await prisma.$transaction(async (tx) => {
    await casUpdate(tx, t, { exception: null });
    await recordEvent(tx, { organizationId: actor.organizationId, contentTargetId: t.id, type: "REOPENED", fromState: state, toState: t.approvalStatus as PublicationState, actorId: actor.id });
  });
  return toPublicationDto(await loadPublication(actor, id), settings.requireApproval);
}

/** Manual retry of a FAILED or STALE publication ("publish now"). The existing publishing worker keeps its duplicate protection (generation + ask-before-resend). */
export async function retryPublication(actor: SafeUser, id: string) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  const state = assertAllowed(t, "RETRY", settings);

  if (settings.requireApproval) {
    if (t.approvalStatus !== "APPROVED") throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "This publication has not been approved, and approval is required.");
    if (!payloadMatchesApproval(t.approvedPayload, payloadOf(t))) throw new ApiHttpError(409, ERROR_CODES.CONFLICT, "The content changed after it was approved. Review it and approve it again.");
  }
  const v = await validatePublicationTarget(t, { settings, now: new Date(), scheduledAt: null, scheduleRequired: false, skipCaps: true });
  if (!v.ok) throw validationError(v.issues, "It cannot be retried yet");

  await prisma.$transaction(async (tx) => {
    await casUpdate(tx, t, { status: "PUBLISHING", exception: null, errorMessage: null });
    await rollUpContent(tx, t.contentId);
    await recordEvent(tx, { organizationId: actor.organizationId, contentTargetId: t.id, type: "RETRIED", fromState: state, toState: "QUEUED", actorId: actor.id });
  });
  await enqueuePublishingJob(t.id);
  return toPublicationDto(await loadPublication(actor, id), settings.requireApproval);
}

/** Dry-run: what would stop this publication from being scheduled at `scheduledAt`? Changes nothing. */
export async function validatePublicationDryRun(actor: SafeUser, id: string, scheduledAt: string | null) {
  const settings = await getEffectiveSettings(actor.organizationId);
  const t = await loadPublication(actor, id);
  return validatePublicationTarget(t, { settings, now: new Date(), scheduledAt: scheduledAt ? parseInstant(scheduledAt) : t.scheduledAt, scheduleRequired: true });
}
