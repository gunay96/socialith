import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { DelayedError, Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@socialith/database";
import { buildTargetPayload } from "@socialith/publishing";
import { QUEUE_NAMES, contentSchedulingJobId } from "@socialith/types";
import { processContentScheduling } from "../processors/content-scheduling.processor.js";
import { buildReconcileConfig, reconcileScheduling } from "../scheduling/reconcile.js";
import { createBullMqSchedulingPort, type SchedulingQueuePort } from "../scheduling/queue-port.js";
import { evaluateApprovalGate } from "../publishing/approval-gate.js";

/**
 * Phase 3 on the REAL engine: MySQL + Redis/BullMQ, no mocks except the platform provider (never reached).
 * Targets of one content item are scheduled independently; ownership, the stale guard, the approval gate and the
 * Redis-loss reconciler all have to keep working per target.
 */
const redisUrl = process.env.REDIS_INTEGRATION_URL;
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL && redisUrl);
const suite = enabled ? describe : describe.skip;

const MIN = 60_000;
const HOUR = 60 * MIN;
const silent = { info: () => undefined, warn: () => undefined };
const config = buildReconcileConfig({ SCHEDULE_STALE_AFTER_MINUTES: 30, PUBLISHING_STUCK_AFTER_MINUTES: 20, PUBLISHING_RECOVERY_MAX_AGE_HOURS: 24 });

const cleanups: (() => Promise<void>)[] = [];
const publishingJobIds: string[] = [];

/**
 * `true` / `false` = an EXPLICITLY saved preference (most tests here exercise mechanics and opt out; the approval tests opt in);
 * `"DEFAULT"` = the organization never saved one, i.e. the product default (approval REQUIRED).
 */
async function makeOrg(label: string, requireApproval: boolean | "DEFAULT" = false) {
  const org = await prisma.organization.create({ data: { name: `IT ${label}`, slug: `it-pc-${label}-${randomUUID().slice(0, 8)}` } });
  if (requireApproval !== "DEFAULT") await prisma.publishingSettings.create({ data: { organizationId: org.id, requireApproval } });
  return org;
}
const makeAccount = (organizationId: string, platform: "TIKTOK" | "INSTAGRAM" | "YOUTUBE" = "TIKTOK") =>
  prisma.socialAccount.create({ data: { organizationId, platform, externalAccountId: `ext-${randomUUID().slice(0, 8)}`, handle: `h${randomUUID().slice(0, 5)}`, displayName: "IT", providerMetadata: { username: "real" } } });

async function makeContent(organizationId: string, scheduledAt: Date | null, status: "SCHEDULED" | "READY" = "SCHEDULED") {
  const content = await prisma.content.create({ data: { organizationId, caption: "base caption", status, scheduledAt } });
  await prisma.contentAsset.create({ data: { contentId: content.id, type: "VIDEO", url: "https://cdn.example.com/v.mp4" } });
  return content;
}
async function makeTarget(contentId: string, socialAccountId: string, at: Date | null, extra: Record<string, unknown> = {}) {
  const t = await prisma.contentTarget.create({ data: { contentId, socialAccountId, status: "SCHEDULED", scheduledAt: at, ...extra } });
  publishingJobIds.push(t.id);
  return t;
}
const target = (id: string) => prisma.contentTarget.findUniqueOrThrow({ where: { id } });
const content = (id: string) => prisma.content.findUniqueOrThrow({ where: { id } });

/** Approves a target exactly the way the API does: the canonical payload computed from the current rows is pinned. */
async function approve(targetId: string) {
  const t = await prisma.contentTarget.findUniqueOrThrow({
    where: { id: targetId },
    include: { socialAccount: { select: { platform: true } }, content: { include: { variations: true, assets: true } } },
  });
  const payload = buildTargetPayload({ platform: t.socialAccount.platform, captionOverride: t.captionOverride, titleOverride: t.titleOverride, content: { caption: t.content.caption, soundId: t.content.soundId, variations: t.content.variations, assets: t.content.assets } });
  await prisma.contentTarget.update({ where: { id: targetId }, data: { approvalStatus: "APPROVED", approvedPayload: payload, approvedAt: new Date() } });
}

function freshPort(): { port: SchedulingQueuePort; inspect: (name: string) => Queue } {
  const prefix = `it-${randomUUID().slice(0, 8)}`;
  const port = createBullMqSchedulingPort(redisUrl!, { prefix });
  const conn = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const queues: Queue[] = [];
  cleanups.push(async () => {
    await port.close();
    await Promise.allSettled(queues.map((q) => q.close()));
    conn.disconnect();
  });
  return { port, inspect: (name) => { const q = new Queue(name, { connection: conn, prefix }); queues.push(q); return q; } };
}

const fakeJob = (contentId: string, moveToDelayed?: (ts: number, token: string) => Promise<void>) => ({ data: { contentId }, ...(moveToDelayed ? { moveToDelayed } : {}) }) as never;

suite("Publishing Center on the real scheduling engine (MySQL + Redis/BullMQ)", () => {
  beforeEach(async () => {
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-pc-" } } });
  });
  afterAll(async () => {
    await Promise.allSettled(cleanups.map((fn) => fn()));
    const conn = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const q = new Queue(QUEUE_NAMES.PUBLISHING, { connection: conn });
    await Promise.allSettled(publishingJobIds.map((id) => q.remove(id)));
    await q.close();
    conn.disconnect();
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-pc-" } } });
    await prisma.$disconnect();
  });

  describe("targets are scheduled independently", () => {
    it("fires only the targets whose OWN time has come, leaves the others SCHEDULED, and moves the job to the next due time", async () => {
      const org = await makeOrg("indep");
      const [a1, a2, a3] = await Promise.all([makeAccount(org.id), makeAccount(org.id), makeAccount(org.id)]);
      const due = new Date(Date.now() - 1_000);
      const later = new Date(Date.now() + 2 * HOUR);
      const evening = new Date(Date.now() + 5 * HOUR);
      const c = await makeContent(org.id, due);
      const t1 = await makeTarget(c.id, a1.id, due);
      const t2 = await makeTarget(c.id, a2.id, later);
      const t3 = await makeTarget(c.id, a3.id, evening);

      const moveToDelayed = vi.fn(async () => undefined);
      await expect(processContentScheduling(fakeJob(c.id, moveToDelayed), "token-1")).rejects.toBeInstanceOf(DelayedError);

      expect((await target(t1.id)).status).toBe("PUBLISHING");
      expect((await target(t2.id)).status).toBe("SCHEDULED");
      expect((await target(t3.id)).status).toBe("SCHEDULED");
      const after = await content(c.id);
      expect(after.status).toBe("SCHEDULED"); // work remains
      expect(Math.abs(after.scheduledAt!.getTime() - later.getTime())).toBeLessThan(1_000); // = the earliest remaining target
      expect(moveToDelayed).toHaveBeenCalledTimes(1);
      const [wakeAt, token] = moveToDelayed.mock.calls[0] as unknown as [number, string];
      expect(token).toBe("token-1");
      expect(Math.abs(wakeAt - later.getTime())).toBeLessThan(1_000);

      const conn = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      const q = new Queue(QUEUE_NAMES.PUBLISHING, { connection: conn });
      expect(await q.getJob(t1.id)).toBeTruthy();
      expect(await q.getJob(t2.id)).toBeFalsy();
      expect(await q.getJob(t3.id)).toBeFalsy();
      await q.close();
      conn.disconnect();
    });

    it("when the last target fires the content moves on to PUBLISHING and the job simply finishes", async () => {
      const org = await makeOrg("last");
      const account = await makeAccount(org.id);
      const at = new Date(Date.now() - 2_000);
      const c = await makeContent(org.id, at);
      const t = await makeTarget(c.id, account.id, at);
      const moveToDelayed = vi.fn(async () => undefined);
      await processContentScheduling(fakeJob(c.id, moveToDelayed), "token"); // resolves: nothing is left to wait for
      expect(moveToDelayed).not.toHaveBeenCalled();
      expect((await target(t.id)).status).toBe("PUBLISHING");
      expect((await content(c.id)).status).toBe("PUBLISHING");
    });

    it("a stale target is held on its own (STALE marker + event); a sibling due later is untouched and the content stays SCHEDULED", async () => {
      const org = await makeOrg("stale");
      const [a1, a2] = await Promise.all([makeAccount(org.id), makeAccount(org.id)]);
      const missed = new Date(Date.now() - 3 * HOUR);
      const future = new Date(Date.now() + 3 * HOUR);
      const c = await makeContent(org.id, missed);
      const t1 = await makeTarget(c.id, a1.id, missed);
      const t2 = await makeTarget(c.id, a2.id, future);

      await expect(processContentScheduling(fakeJob(c.id, async () => undefined), "tok")).rejects.toBeInstanceOf(DelayedError);

      const held = await target(t1.id);
      expect(held.status).toBe("FAILED");
      expect(held.exception).toBe("STALE");
      expect(held.errorMessage).toMatch(/Missed its scheduled time/);
      expect((await target(t2.id)).status).toBe("SCHEDULED");
      const after = await content(c.id);
      expect(after.status).toBe("SCHEDULED");
      expect(Math.abs(after.scheduledAt!.getTime() - future.getTime())).toBeLessThan(1_000);
      expect(await prisma.publishAttempt.count({ where: { contentTargetId: t1.id } })).toBe(0); // never published
      expect(await prisma.publicationEvent.count({ where: { contentTargetId: t1.id, type: "MARKED_STALE" } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "SCHEDULE_HELD_STALE", targetId: c.id } })).toBe(1);
    });

    it("targets the Upload-Post scheduler owns are never fired by Socialith, while a due sibling still is (one owner per target)", async () => {
      const org = await makeOrg("owner");
      const [a1, a2] = await Promise.all([makeAccount(org.id), makeAccount(org.id)]);
      const due = new Date(Date.now() - 1_000);
      const c = await makeContent(org.id, due);
      const ours = await makeTarget(c.id, a1.id, due);
      const theirs = await makeTarget(c.id, a2.id, due);
      await prisma.uploadPostPublication.create({
        data: { organizationId: org.id, contentTargetId: theirs.id, mode: "PROVIDER_SCHEDULED", status: "SCHEDULED_AT_PROVIDER", externalId: `socialith:target:${theirs.id}:g1`, requestId: `sl-${theirs.id}-g1`, idempotencyKey: "k", profileUsername: "p", platform: "tiktok", providerJobId: "job_x", scheduledFor: due },
      });
      await processContentScheduling(fakeJob(c.id));
      expect((await target(ours.id)).status).toBe("PUBLISHING");
      expect((await target(theirs.id)).status).toBe("SCHEDULED"); // the provider's clock
    });
  });

  describe("the approval gate (organizations that require approval)", () => {
    it("an unapproved due target is HELD — never fired, never failed — with an event saying why", async () => {
      const org = await makeOrg("gate-unapproved", true);
      const account = await makeAccount(org.id);
      const at = new Date(Date.now() - 1_000);
      const c = await makeContent(org.id, at);
      const t = await makeTarget(c.id, account.id, at);
      await processContentScheduling(fakeJob(c.id));
      const row = await target(t.id);
      expect(row.status).toBe("PENDING");
      expect(row.exception).toBe("HELD");
      expect(row.errorMessage).toMatch(/not been approved/);
      const event = await prisma.publicationEvent.findFirstOrThrow({ where: { contentTargetId: t.id, type: "HELD" } });
      expect(event.actorId).toBeNull();
      expect(event.metadata).toMatchObject({ gate: "NOT_APPROVED" });
      expect((await content(c.id)).status).not.toBe("PUBLISHING");
    });

    it("an approved target whose content was edited after approval is held too (CONTENT_CHANGED)", async () => {
      const org = await makeOrg("gate-changed", true);
      const account = await makeAccount(org.id);
      const at = new Date(Date.now() - 1_000);
      const c = await makeContent(org.id, at);
      const t = await makeTarget(c.id, account.id, at);
      await approve(t.id);
      await prisma.content.update({ where: { id: c.id }, data: { caption: "edited after approval" } });
      await processContentScheduling(fakeJob(c.id));
      expect((await target(t.id)).exception).toBe("HELD");
      expect((await prisma.publicationEvent.findFirstOrThrow({ where: { contentTargetId: t.id, type: "HELD" } })).metadata).toMatchObject({ gate: "CONTENT_CHANGED" });
    });

    it("an approved, unchanged target fires", async () => {
      const org = await makeOrg("gate-ok", true);
      const account = await makeAccount(org.id);
      const at = new Date(Date.now() - 1_000);
      const c = await makeContent(org.id, at);
      const t = await makeTarget(c.id, account.id, at);
      await approve(t.id);
      await processContentScheduling(fakeJob(c.id));
      expect((await target(t.id)).status).toBe("PUBLISHING");
    });

    it("APPROVAL IS THE DEFAULT: an organization that never saved a preference is gated exactly like one that requires approval", async () => {
      const org = await makeOrg("gate-default", "DEFAULT");
      expect(await prisma.publishingSettings.count({ where: { organizationId: org.id } })).toBe(0);
      const account = await makeAccount(org.id);
      const at = new Date(Date.now() - 1_000);
      const c = await makeContent(org.id, at);
      const t = await makeTarget(c.id, account.id, at);
      await processContentScheduling(fakeJob(c.id));
      expect(await target(t.id)).toMatchObject({ status: "PENDING", exception: "HELD" });
      expect(await evaluateApprovalGate(prisma, t.id)).toMatchObject({ ok: false, code: "NOT_APPROVED" });
      expect(await prisma.publishAttempt.count({ where: { contentTargetId: t.id } })).toBe(0); // nothing reached any provider
      // once approved and re-scheduled (what the API does: target SCHEDULED again, content rolled up to SCHEDULED) it goes out, with no preference ever saved
      await prisma.contentTarget.update({ where: { id: t.id }, data: { status: "SCHEDULED", exception: null } });
      await prisma.content.update({ where: { id: c.id }, data: { status: "SCHEDULED" } });
      await approve(t.id);
      await processContentScheduling(fakeJob(c.id));
      expect((await target(t.id)).status).toBe("PUBLISHING");
    });

    it("an EXPLICITLY saved opt-out is honoured (never silently re-enabled by the default)", async () => {
      const org = await makeOrg("gate-optout", false);
      const account = await makeAccount(org.id);
      const at = new Date(Date.now() - 1_000);
      const c = await makeContent(org.id, at);
      const t = await makeTarget(c.id, account.id, at);
      await processContentScheduling(fakeJob(c.id));
      expect((await target(t.id)).status).toBe("PUBLISHING");
      expect(await evaluateApprovalGate(prisma, t.id)).toEqual({ ok: true });
    });
    it("the gate is evaluated per destination: the approved one fires, its unapproved sibling is held", async () => {
      const org = await makeOrg("gate-per-dest", true);
      const [a1, a2] = await Promise.all([makeAccount(org.id), makeAccount(org.id)]);
      const at = new Date(Date.now() - 1_000);
      const c = await makeContent(org.id, at);
      const approved = await makeTarget(c.id, a1.id, at);
      const unapproved = await makeTarget(c.id, a2.id, at);
      await approve(approved.id);
      await processContentScheduling(fakeJob(c.id));
      expect((await target(approved.id)).status).toBe("PUBLISHING");
      expect((await target(unapproved.id)).exception).toBe("HELD");
    });

    it("a destination's own caption is part of what was approved: changing it afterwards breaks the approval", async () => {
      const org = await makeOrg("gate-override", true);
      const account = await makeAccount(org.id);
      const c = await makeContent(org.id, new Date(Date.now() + HOUR));
      const t = await makeTarget(c.id, account.id, new Date(Date.now() + HOUR), { captionOverride: "written for this page" });
      await approve(t.id);
      expect((await evaluateApprovalGate(prisma, t.id)).ok).toBe(true);
      await prisma.contentTarget.update({ where: { id: t.id }, data: { captionOverride: "someone changed it" } });
      expect(await evaluateApprovalGate(prisma, t.id)).toMatchObject({ ok: false, code: "CONTENT_CHANGED" });
    });
  });

  describe("held and cancelled targets do not keep a content open", () => {
    it("content rolls up to PUBLISHED when the only other target is cancelled, and the reconciler finalizes it", async () => {
      const org = await makeOrg("rollup");
      const [a1, a2] = await Promise.all([makeAccount(org.id), makeAccount(org.id)]);
      const c = await makeContent(org.id, null, "READY");
      await prisma.content.update({ where: { id: c.id }, data: { status: "PUBLISHING" } });
      await prisma.contentTarget.create({ data: { contentId: c.id, socialAccountId: a1.id, status: "PUBLISHED", publishedAt: new Date() } });
      await prisma.contentTarget.create({ data: { contentId: c.id, socialAccountId: a2.id, status: "PENDING", exception: "CANCELLED" } });
      const { port } = freshPort();
      const summary = await reconcileScheduling({ db: prisma, port, config, log: silent });
      expect(summary.contentFinalized).toBe(1);
      expect((await content(c.id)).status).toBe("PUBLISHED");
    });
  });

  describe("Redis data loss: the reconciler re-creates the missing job from the database, per target", () => {
    it("re-creates the job at the EARLIEST remaining target's time, once", async () => {
      const org = await makeOrg("redis-loss");
      const [a1, a2] = await Promise.all([makeAccount(org.id), makeAccount(org.id)]);
      const t1At = new Date(Date.now() + 2 * HOUR);
      const t2At = new Date(Date.now() + 6 * HOUR);
      const c = await makeContent(org.id, t1At);
      await makeTarget(c.id, a1.id, t1At);
      await makeTarget(c.id, a2.id, t2At);
      const { port, inspect } = freshPort(); // an empty Redis: every job was lost
      const first = await reconcileScheduling({ db: prisma, port, config, log: silent });
      expect(first.schedulingJobsEnqueued).toBe(1);
      const job = await inspect(QUEUE_NAMES.CONTENT_SCHEDULING).getJob(contentSchedulingJobId(c.id));
      expect(Math.abs((job!.opts.delay ?? 0) - 2 * HOUR)).toBeLessThan(10_000);
      expect((await reconcileScheduling({ db: prisma, port, config, log: silent })).schedulingJobsEnqueued).toBe(0);
    });

    it("an earlier stale target is held and the job is re-created for the LATER target — nothing is published", async () => {
      const org = await makeOrg("redis-stale");
      const [a1, a2] = await Promise.all([makeAccount(org.id), makeAccount(org.id)]);
      const missed = new Date(Date.now() - 5 * HOUR);
      const future = new Date(Date.now() + 4 * HOUR);
      const c = await makeContent(org.id, missed);
      const t1 = await makeTarget(c.id, a1.id, missed);
      const t2 = await makeTarget(c.id, a2.id, future);
      const { port, inspect } = freshPort();
      const summary = await reconcileScheduling({ db: prisma, port, config, log: silent });
      expect(summary.heldStale).toBe(1);
      expect(summary.schedulingJobsEnqueued).toBe(1);
      expect((await target(t1.id)).exception).toBe("STALE");
      expect((await target(t2.id)).status).toBe("SCHEDULED");
      const job = await inspect(QUEUE_NAMES.CONTENT_SCHEDULING).getJob(contentSchedulingJobId(c.id));
      expect(Math.abs((job!.opts.delay ?? 0) - 4 * HOUR)).toBeLessThan(10_000);
      expect(await prisma.publishAttempt.count({ where: { contentTargetId: { in: [t1.id, t2.id] } } })).toBe(0);
    });

    it("content whose every remaining target is provider-owned gets no Socialith job (one owner at a time)", async () => {
      const org = await makeOrg("redis-owner");
      const account = await makeAccount(org.id);
      const at = new Date(Date.now() + 3 * HOUR);
      const c = await makeContent(org.id, at);
      const t = await makeTarget(c.id, account.id, at);
      await prisma.uploadPostPublication.create({
        data: { organizationId: org.id, contentTargetId: t.id, mode: "PROVIDER_SCHEDULED", status: "SCHEDULED_AT_PROVIDER", externalId: `socialith:target:${t.id}:g1`, requestId: `sl-${t.id}-g1`, idempotencyKey: "k", profileUsername: "p", platform: "tiktok", providerJobId: "job_y", scheduledFor: at },
      });
      const { port, inspect } = freshPort();
      const summary = await reconcileScheduling({ db: prisma, port, config, log: silent });
      expect(summary.skippedProviderOwned).toBe(1);
      expect(summary.schedulingJobsEnqueued).toBe(0);
      expect(await inspect(QUEUE_NAMES.CONTENT_SCHEDULING).getJob(contentSchedulingJobId(c.id))).toBeFalsy();
    });
  });
});
