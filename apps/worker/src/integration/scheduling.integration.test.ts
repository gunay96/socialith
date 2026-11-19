import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@socialith/database";
import { QUEUE_NAMES, contentSchedulingJobId } from "@socialith/types";
import { processContentScheduling } from "../processors/content-scheduling.processor.js";
import { processPublishing } from "../processors/publishing.processor.js";
import { ensureRepeatable } from "../scheduling/ensure-repeatable.js";
import { createBullMqSchedulingPort, type SchedulingQueuePort } from "../scheduling/queue-port.js";
import { buildReconcileConfig, reconcileScheduling } from "../scheduling/reconcile.js";

// The one thing that must never happen for demo/seed data: a platform call.
vi.mock("../publishing/resolve-provider.js", () => ({
  resolvePublishingProvider: vi.fn(() => {
    throw new Error("PLATFORM PROVIDER MUST NOT BE REACHED");
  }),
}));

/**
 * REAL MySQL + REAL Redis/BullMQ: the scheduling reconciler, the stale-content
 * guard and the demo-account guard, with no mocks except the platform provider
 * (which must never be reached). Skipped unless both URLs are set — run via
 * `pnpm --filter @socialith/worker test:integration` (docs/DATABASE_MYSQL.md).
 */
const redisUrl = process.env.REDIS_INTEGRATION_URL;
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL && redisUrl);
const suite = enabled ? describe : describe.skip;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const config = buildReconcileConfig({
  SCHEDULE_STALE_AFTER_MINUTES: 30,
  PUBLISHING_STUCK_AFTER_MINUTES: 20,
  PUBLISHING_RECOVERY_MAX_AGE_HOURS: 24,
});
const silent = { info: () => undefined, warn: () => undefined };

const createdOrganizationIds: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

async function makeOrg(label: string) {
  const org = await prisma.organization.create({ data: { name: `IT ${label}`, slug: `it-${label}-${randomUUID().slice(0, 8)}` } });
  createdOrganizationIds.push(org.id);
  return org;
}

async function makeAccount(organizationId: string, demo: boolean, platform: "TIKTOK" | "INSTAGRAM" | "YOUTUBE" = "TIKTOK") {
  return prisma.socialAccount.create({
    data: {
      organizationId,
      platform,
      externalAccountId: `ext-${randomUUID().slice(0, 8)}`,
      handle: "@it",
      displayName: "IT",
      providerMetadata: demo ? { seed: true } : { username: "real" },
    },
  });
}

async function makeContent(
  organizationId: string,
  status: "SCHEDULED" | "PUBLISHING" | "DRAFT",
  scheduledAt: Date | null,
  withAsset = true,
) {
  const content = await prisma.content.create({ data: { organizationId, caption: "IT caption", status, scheduledAt } });
  if (withAsset) await prisma.contentAsset.create({ data: { contentId: content.id, type: "VIDEO", url: "https://cdn.example.com/v.mp4" } });
  return content;
}

async function makeTarget(
  contentId: string,
  socialAccountId: string,
  status: "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "PENDING",
  extra: { externalPostId?: string; scheduledAt?: Date } = {},
) {
  return prisma.contentTarget.create({ data: { contentId, socialAccountId, status, ...extra } });
}

/** updatedAt is @updatedAt-managed by Prisma, so backdate it with raw SQL. */
async function backdateTarget(id: string, ageMs: number) {
  const when = new Date(Date.now() - ageMs);
  await prisma.$executeRaw`UPDATE content_targets SET updated_at = ${when} WHERE id = ${id}`;
}

/** A port on its own, uniquely-prefixed BullMQ keyspace — tests never see each other's jobs. */
function freshPort(): { port: SchedulingQueuePort; prefix: string; inspect: (name: string) => Queue } {
  const prefix = `it-${randomUUID().slice(0, 8)}`;
  const port = createBullMqSchedulingPort(redisUrl!, { prefix });
  const inspectConnection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const queues: Queue[] = [];
  cleanups.push(async () => {
    await port.close();
    await Promise.allSettled(queues.map((q) => q.close()));
    inspectConnection.disconnect();
  });
  return {
    port,
    prefix,
    inspect: (name) => {
      const q = new Queue(name, { connection: inspectConnection, prefix });
      queues.push(q);
      return q;
    },
  };
}

const reconcile = (port: SchedulingQueuePort, now?: Date) =>
  reconcileScheduling({ db: prisma, port, config, now: now ? () => now : undefined, log: silent });

suite("scheduling reconciliation (real MySQL + real Redis/BullMQ)", () => {
  // The reconciler deliberately scans the WHOLE database, so every test must
  // start from a database that contains none of the previous tests' rows.
  // Only organizations created by these suites (slug prefix "it-") are
  // removed — cascades take their content/targets/jobs with them.
  beforeEach(async () => {
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-" } } });
  });

  afterAll(async () => {
    await Promise.allSettled(cleanups.map((fn) => fn()));
    if (createdOrganizationIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    await prisma.$disconnect();
  });

  describe("SCHEDULED content", () => {
    it("re-creates the missing delayed job for FUTURE content, with the right delay, once", async () => {
      const org = await makeOrg("future");
      const account = await makeAccount(org.id, false);
      const at = new Date(Date.now() + 3 * 60 * MIN);
      const content = await makeContent(org.id, "SCHEDULED", at);
      await makeTarget(content.id, account.id, "SCHEDULED", { scheduledAt: at });
      const { port, inspect } = freshPort();

      const first = await reconcile(port);
      expect(first.schedulingJobsEnqueued).toBe(1);

      const job = await inspect(QUEUE_NAMES.CONTENT_SCHEDULING).getJob(contentSchedulingJobId(content.id));
      expect(job).toBeTruthy();
      expect(await job!.getState()).toBe("delayed");
      expect(Math.abs((job!.opts.delay ?? 0) - 3 * 60 * MIN)).toBeLessThan(10_000);

      const second = await reconcile(port);
      expect(second.schedulingJobsEnqueued).toBe(0);
    });

    it("enqueues DUE content (late but inside the window) for immediate execution", async () => {
      const org = await makeOrg("due");
      const content = await makeContent(org.id, "SCHEDULED", new Date(Date.now() - 5 * MIN));
      const { port, inspect } = freshPort();

      const summary = await reconcile(port);
      expect(summary.schedulingJobsEnqueued).toBe(1);
      expect(summary.heldStale).toBe(0);
      const job = await inspect(QUEUE_NAMES.CONTENT_SCHEDULING).getJob(contentSchedulingJobId(content.id));
      expect(job?.opts.delay).toBe(0);
    });

    it("HOLDS stale content: never published, explained, audited, its old job removed", async () => {
      const org = await makeOrg("stale");
      const account = await makeAccount(org.id, false);
      const at = new Date(Date.now() - 2 * DAY);
      const content = await makeContent(org.id, "SCHEDULED", at);
      const target = await makeTarget(content.id, account.id, "SCHEDULED", { scheduledAt: at });
      const { port, inspect } = freshPort();

      // An old, leftover job for this content (e.g. restored from a Redis snapshot).
      const scheduling = inspect(QUEUE_NAMES.CONTENT_SCHEDULING);
      await scheduling.add(QUEUE_NAMES.CONTENT_SCHEDULING, { contentId: content.id }, { jobId: contentSchedulingJobId(content.id), delay: 60 * MIN });

      const summary = await reconcile(port);
      expect(summary.heldStale).toBe(1);
      expect(summary.schedulingJobsEnqueued).toBe(0);

      expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe("FAILED");
      const heldTarget = await prisma.contentTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(heldTarget.status).toBe("FAILED");
      expect(heldTarget.errorMessage).toMatch(/Missed its scheduled time/);
      expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "SCHEDULE_HELD_STALE", targetId: content.id } })).toBe(1);
      expect(await scheduling.getJob(contentSchedulingJobId(content.id))).toBeFalsy();
      expect(await prisma.publishAttempt.count({ where: { contentTargetId: target.id } })).toBe(0);

      // Idempotent: a second run neither re-holds nor writes a second audit row.
      expect((await reconcile(port)).heldStale).toBe(0);
      expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "SCHEDULE_HELD_STALE" } })).toBe(1);
    });

    it("the seed scenario: a 58-day-overdue SCHEDULED row on demo accounts is held, nothing is published or enqueued", async () => {
      const org = await makeOrg("seed");
      const accounts = await Promise.all([makeAccount(org.id, true, "TIKTOK"), makeAccount(org.id, true, "INSTAGRAM"), makeAccount(org.id, true, "YOUTUBE")]);
      const at = new Date(Date.now() - 58 * DAY);
      const content = await makeContent(org.id, "SCHEDULED", at);
      const targets = await Promise.all(accounts.map((a) => makeTarget(content.id, a.id, "SCHEDULED", { scheduledAt: at })));
      const { port, inspect } = freshPort();

      const summary = await reconcile(port);
      expect(summary.heldStale).toBe(1);

      const rows = await prisma.contentTarget.findMany({ where: { id: { in: targets.map((t) => t.id) } } });
      expect(rows.every((r) => r.status === "FAILED")).toBe(true);
      // No job of any kind is queued or runnable anywhere: nothing can publish.
      const runnable = async (queue: Queue) =>
        Object.values(await queue.getJobCounts("waiting", "delayed", "active", "prioritized")).reduce((sum, n) => sum + n, 0);
      expect(await runnable(inspect(QUEUE_NAMES.CONTENT_SCHEDULING))).toBe(0);
      expect(await runnable(inspect(QUEUE_NAMES.PUBLISHING))).toBe(0);
      expect(await runnable(inspect(QUEUE_NAMES.PUBLISH_STATUS_POLL))).toBe(0);
    });

    it("replaces a FINISHED job (completed but content still SCHEDULED) with a live one", async () => {
      const org = await makeOrg("finished");
      const content = await makeContent(org.id, "SCHEDULED", new Date(Date.now() + 60 * MIN));
      const { port, prefix, inspect } = freshPort();
      const scheduling = inspect(QUEUE_NAMES.CONTENT_SCHEDULING);

      // Run a real consumer that completes the job immediately.
      await scheduling.add(QUEUE_NAMES.CONTENT_SCHEDULING, { contentId: content.id }, { jobId: contentSchedulingJobId(content.id) });
      const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      const worker = new Worker(QUEUE_NAMES.CONTENT_SCHEDULING, async () => undefined, { connection, prefix });
      await new Promise<void>((resolve) => worker.on("completed", () => resolve()));
      await worker.close();
      connection.disconnect();
      const before = await scheduling.getJob(contentSchedulingJobId(content.id));
      expect(await before!.getState()).toBe("completed");

      const summary = await reconcile(port);
      expect(summary.schedulingJobsEnqueued).toBe(1);
      const after = await scheduling.getJob(contentSchedulingJobId(content.id));
      expect(await after!.getState()).toBe("delayed");
    });

    it("does not touch content that is not SCHEDULED", async () => {
      const org = await makeOrg("not-scheduled");
      await makeContent(org.id, "DRAFT", new Date(Date.now() - 5 * DAY));
      const { port } = freshPort();
      const summary = await reconcile(port);
      expect(summary.heldStale).toBe(0);
      expect(summary.schedulingJobsEnqueued).toBe(0);
    });
  });

  describe("targets stuck in PUBLISHING", () => {
    it("restores a missing publishing job; leaves fresh targets and live jobs alone", async () => {
      const org = await makeOrg("stuck");
      const account = await makeAccount(org.id, false);
      const content = await makeContent(org.id, "PUBLISHING", new Date(Date.now() - 2 * 60 * MIN));
      const stuck = await makeTarget(content.id, account.id, "PUBLISHING");
      const fresh = await makeTarget(content.id, (await makeAccount(org.id, false)).id, "PUBLISHING");
      await backdateTarget(stuck.id, 40 * MIN);
      const { port, inspect } = freshPort();

      const summary = await reconcile(port);
      expect(summary.stuckPublishingRequeued).toBe(1);
      const publishing = inspect(QUEUE_NAMES.PUBLISHING);
      expect(await publishing.getJob(stuck.id)).toBeTruthy();
      expect(await publishing.getJob(fresh.id)).toBeFalsy();

      // The job is now live, so a second run must not create another.
      expect((await reconcile(port)).stuckPublishingRequeued).toBe(0);
    });

    it("restores the STATUS-POLL job (not a re-publish) when the provider already returned a post id", async () => {
      const org = await makeOrg("stuck-poll");
      const account = await makeAccount(org.id, false);
      const content = await makeContent(org.id, "PUBLISHING", new Date(Date.now() - 2 * 60 * MIN));
      const target = await makeTarget(content.id, account.id, "PUBLISHING", { externalPostId: "publish-id-123" });
      await backdateTarget(target.id, 40 * MIN);
      const { port, inspect } = freshPort();

      const summary = await reconcile(port);
      expect(summary.stuckPollsRestored).toBe(1);
      expect(summary.stuckPublishingRequeued).toBe(0);
      expect(await inspect(QUEUE_NAMES.PUBLISH_STATUS_POLL).getJob(target.id)).toBeTruthy();
      expect(await inspect(QUEUE_NAMES.PUBLISHING).getJob(target.id)).toBeFalsy();
    });

    it("fails (never republishes) a target stuck past the recovery limit", async () => {
      const org = await makeOrg("stuck-old");
      const account = await makeAccount(org.id, false);
      const content = await makeContent(org.id, "PUBLISHING", new Date(Date.now() - 3 * DAY));
      const target = await makeTarget(content.id, account.id, "PUBLISHING");
      await backdateTarget(target.id, 30 * 60 * MIN); // 30 hours
      const { port, inspect } = freshPort();

      const summary = await reconcile(port);
      expect(summary.stuckFailed).toBe(1);
      const row = await prisma.contentTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.status).toBe("FAILED");
      expect(row.errorMessage).toMatch(/Stuck in PUBLISHING/);
      expect(await inspect(QUEUE_NAMES.PUBLISHING).getJob(target.id)).toBeFalsy();
    });
  });

  describe("content roll-up", () => {
    it("finalizes PUBLISHING content whose targets are all terminal; ignores zero-target content", async () => {
      const org = await makeOrg("rollup");
      const a = await makeAccount(org.id, false);
      const b = await makeAccount(org.id, false);
      const mixed = await makeContent(org.id, "PUBLISHING", new Date(Date.now() - 60 * MIN));
      await makeTarget(mixed.id, a.id, "PUBLISHED");
      await makeTarget(mixed.id, b.id, "FAILED");
      const allGood = await makeContent(org.id, "PUBLISHING", new Date(Date.now() - 60 * MIN));
      await makeTarget(allGood.id, a.id, "PUBLISHED");
      const noTargets = await makeContent(org.id, "PUBLISHING", new Date(Date.now() - 60 * MIN));
      const stillRunning = await makeContent(org.id, "PUBLISHING", new Date(Date.now() - 60 * MIN));
      await makeTarget(stillRunning.id, a.id, "PUBLISHING");
      const { port } = freshPort();

      await reconcile(port);

      const status = async (id: string) => (await prisma.content.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(mixed.id)).toBe("FAILED");
      expect(await status(allGood.id)).toBe("PUBLISHED");
      expect(await status(noTargets.id)).toBe("PUBLISHING");
      expect(await status(stillRunning.id)).toBe("PUBLISHING");
    });
  });

  describe("the scheduling processor itself (stale guard on the live path)", () => {
    const job = (contentId: string) => ({ data: { contentId } }) as never;

    it("a job that fires hours late holds the content instead of publishing it", async () => {
      const org = await makeOrg("proc-stale");
      const account = await makeAccount(org.id, false);
      const at = new Date(Date.now() - 3 * 60 * MIN);
      const content = await makeContent(org.id, "SCHEDULED", at);
      const target = await makeTarget(content.id, account.id, "SCHEDULED", { scheduledAt: at });

      await processContentScheduling(job(content.id));

      expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe("FAILED");
      expect((await prisma.contentTarget.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("FAILED");
    });

    it("a job that fires on time still publishes (transitions to PUBLISHING)", async () => {
      const org = await makeOrg("proc-ok");
      const account = await makeAccount(org.id, false);
      const at = new Date(Date.now() - 2_000);
      const content = await makeContent(org.id, "SCHEDULED", at);
      const target = await makeTarget(content.id, account.id, "SCHEDULED", { scheduledAt: at });

      await processContentScheduling(job(content.id));

      expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe("PUBLISHING");
      expect((await prisma.contentTarget.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("PUBLISHING");
      // clean up the publishing job this enqueued on the default keyspace
      const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      const q = new Queue(QUEUE_NAMES.PUBLISHING, { connection });
      expect(await q.getJob(target.id)).toBeTruthy();
      await q.remove(target.id);
      await q.close();
      connection.disconnect();
    });

    it("a job that fires far too early leaves the content SCHEDULED for the reconciler", async () => {
      const org = await makeOrg("proc-early");
      const account = await makeAccount(org.id, false);
      const at = new Date(Date.now() + 2 * 60 * MIN);
      const content = await makeContent(org.id, "SCHEDULED", at);
      await makeTarget(content.id, account.id, "SCHEDULED", { scheduledAt: at });

      await processContentScheduling(job(content.id));

      expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe("SCHEDULED");
    });
  });

  describe("repeatable schedules survive Redis state loss (found by wiping Redis under a running stack)", () => {
    /** Deletes every key of ONE test keyspace — a stand-in for "Redis lost its data", without FLUSHALL (never run that against a shared Redis). */
    async function wipeKeyspace(prefix: string): Promise<number> {
      const redis = new Redis(redisUrl!);
      try {
        const keys = await redis.keys(`${prefix}:*`);
        if (keys.length > 0) await redis.del(...keys);
        return keys.length;
      } finally {
        redis.disconnect();
      }
    }
    const spec = { name: QUEUE_NAMES.SCHEDULING_RECONCILE, jobId: "scheduling-reconcile", everyMs: 60_000 };

    it("registers once, then reports it is already present (no duplicates)", async () => {
      const { inspect } = freshPort();
      const queue = inspect(QUEUE_NAMES.SCHEDULING_RECONCILE);
      expect(await ensureRepeatable(queue, spec)).toBe("registered");
      expect(await ensureRepeatable(queue, spec)).toBe("present");
      expect(await ensureRepeatable(queue, spec)).toBe("present");
      expect(await queue.getRepeatableJobs()).toHaveLength(1);
    });

    it("re-registers after Redis loses everything — the reconciler's schedule comes back", async () => {
      const { prefix, inspect } = freshPort();
      const queue = inspect(QUEUE_NAMES.SCHEDULING_RECONCILE);
      expect(await ensureRepeatable(queue, spec)).toBe("registered");
      expect(await queue.getRepeatableJobs()).toHaveLength(1);

      expect(await wipeKeyspace(prefix)).toBeGreaterThan(0);
      expect(await queue.getRepeatableJobs()).toHaveLength(0); // the periodic work has silently stopped

      expect(await ensureRepeatable(queue, spec)).toBe("registered");
      expect(await queue.getRepeatableJobs()).toHaveLength(1);
    });

    it("replaces a stale interval instead of running two schedules side by side", async () => {
      const { inspect } = freshPort();
      const queue = inspect(QUEUE_NAMES.SCHEDULING_RECONCILE);
      await ensureRepeatable(queue, { ...spec, everyMs: 60_000 });
      expect(await ensureRepeatable(queue, { ...spec, everyMs: 30_000 })).toBe("registered");
      const repeatables = await queue.getRepeatableJobs();
      expect(repeatables).toHaveLength(1);
      expect(Number(repeatables[0]!.every)).toBe(30_000);
    });

    it("end to end: a pending job lost with Redis is re-created by the next reconcile", async () => {
      const org = await makeOrg("state-loss");
      const content = await makeContent(org.id, "SCHEDULED", new Date(Date.now() + 10 * MIN));
      const { port, prefix, inspect } = freshPort();
      const scheduling = inspect(QUEUE_NAMES.CONTENT_SCHEDULING);

      expect((await reconcile(port)).schedulingJobsEnqueued).toBe(1);
      expect(await scheduling.getJob(contentSchedulingJobId(content.id))).toBeTruthy();

      await wipeKeyspace(prefix);
      expect(await scheduling.getJob(contentSchedulingJobId(content.id))).toBeFalsy();

      expect((await reconcile(port)).schedulingJobsEnqueued).toBe(1);
      expect(await scheduling.getJob(contentSchedulingJobId(content.id))).toBeTruthy();
    });
  });

  describe("demo/seed accounts can never reach a platform", () => {
    it("processPublishing fails the target without calling any provider", async () => {
      const org = await makeOrg("demo-publish");
      const account = await makeAccount(org.id, true);
      const content = await makeContent(org.id, "PUBLISHING", new Date());
      const target = await makeTarget(content.id, account.id, "PUBLISHING");

      await processPublishing({ data: { contentTargetId: target.id } } as never);

      const row = await prisma.contentTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.status).toBe("FAILED");
      expect(row.errorMessage).toMatch(/demo/i);
      const attempt = await prisma.publishAttempt.findFirstOrThrow({ where: { contentTargetId: target.id } });
      expect(attempt.errorCode).toBe("CONFIGURATION_ERROR");
      expect(attempt.retryable).toBe(false);
      expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe("FAILED");
      // the account is not marked ERROR/disconnected — demo data stays as seeded
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("CONNECTED");
    });
  });
});
