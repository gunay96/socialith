import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@socialith/database";
import { UploadPostClient, defaultProfiles, startMockUploadPostServer, type MockUploadPostHandle } from "@socialith/upload-post";

vi.mock("../publishing/enqueue.js", () => ({
  enqueuePublishingJob: vi.fn(async () => undefined),
  enqueuePublishStatusPoll: vi.fn(async () => undefined),
  closePublishingQueueProducer: vi.fn(async () => undefined),
}));

import { enqueuePublishingJob } from "../publishing/enqueue.js";
import { processContentScheduling } from "../processors/content-scheduling.processor.js";
import { buildReconcileConfig, reconcileScheduling } from "../scheduling/reconcile.js";
import type { SchedulingQueuePort } from "../scheduling/queue-port.js";
import { sweepUploadPost, type SweepConfig, type SweepMaterial } from "../upload-post/sweep.js";
import { syncUploadPostProfiles } from "../upload-post/sync.js";

/**
 * Hybrid scheduling (Socialith owns the master schedule; Upload-Post may run upcoming jobs inside a controlled
 * window). Real MySQL, contract double — nothing reaches the live service. The central invariant: a target is
 * NEVER scheduled in both systems.
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL && process.env.REDIS_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;
const silent = { info: () => undefined, warn: () => undefined };
const KEY = "test-key-0000000000";
const MIN = 60_000;
const HOUR = 60 * MIN;
let mock: MockUploadPostHandle;
let client: UploadPostClient;

const CONFIG: SweepConfig = { handoffEnabled: true, handoffWindowMs: 48 * HOUR, minLeadMs: 10 * MIN, unconfirmedAfterMs: 6 * HOUR };
const durable: SweepMaterial = { caption: "Scheduled caption", title: null, assets: [{ type: "VIDEO", url: "https://media.example.test/v.mp4" }], durable: true };

const sweep = (over: Partial<Parameters<typeof sweepUploadPost>[0]> = {}) =>
  sweepUploadPost({ db: prisma, client, config: CONFIG, resolveMaterial: async () => durable, log: silent, ...over });

async function setup(scheduledInMs: number, platform: "tiktok" | "instagram" = "tiktok") {
  const org = await prisma.organization.create({ data: { name: "IT SW", slug: `it-sw-${randomUUID().slice(0, 8)}` } });
  await syncUploadPostProfiles({ db: prisma, client, log: silent }, org.id, "MANUAL");
  const profile = await prisma.uploadPostProfile.findUniqueOrThrow({ where: { organizationId_username: { organizationId: org.id, username: "acme_music" } } });
  const acc = await prisma.uploadPostConnectedAccount.findUniqueOrThrow({ where: { profileId_platform: { profileId: profile.id, platform } } });
  const social = await prisma.socialAccount.create({
    data: { organizationId: org.id, platform: platform.toUpperCase() as "TIKTOK", externalAccountId: acc.providerAccountId, handle: "h", displayName: "d", publishingProvider: "UPLOAD_POST" },
  });
  await prisma.uploadPostConnectedAccount.update({ where: { id: acc.id }, data: { socialAccountId: social.id } });
  const content = await prisma.content.create({ data: { organizationId: org.id, caption: "c", status: "SCHEDULED", scheduledAt: new Date(Date.now() + scheduledInMs) } });
  await prisma.contentAsset.create({ data: { contentId: content.id, type: "VIDEO", url: "https://media.example.test/v.mp4" } });
  const target = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: social.id, status: "SCHEDULED", scheduledAt: content.scheduledAt } });
  return { org, social, content, target };
}
const pub = (targetId: string) => prisma.uploadPostPublication.findUniqueOrThrow({ where: { contentTargetId: targetId } });
const tgt = (id: string) => prisma.contentTarget.findUniqueOrThrow({ where: { id } });
const cnt = (id: string) => prisma.content.findUniqueOrThrow({ where: { id } });

function fakePort(): SchedulingQueuePort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    contentSchedulingLiveness: async () => "missing",
    enqueueContentScheduling: async (id: string) => void calls.push(`enqueue-scheduling:${id}`),
    removeContentScheduling: async (id: string) => void calls.push(`remove-scheduling:${id}`),
    publishStatusPollLiveness: async () => "missing",
    enqueuePublishStatusPoll: async (id: string) => void calls.push(`enqueue-poll:${id}`),
    publishingLiveness: async () => "missing",
    enqueuePublishing: async (id: string) => void calls.push(`enqueue-publishing:${id}`),
    close: async () => undefined,
  } as unknown as SchedulingQueuePort & { calls: string[] };
}
const reconcileConfig = buildReconcileConfig({ SCHEDULE_STALE_AFTER_MINUTES: 30, PUBLISHING_STUCK_AFTER_MINUTES: 20, PUBLISHING_RECOVERY_MAX_AGE_HOURS: 24 });

suite("Upload-Post hybrid scheduling (real MySQL, contract double)", () => {
  beforeAll(async () => {
    mock = await startMockUploadPostServer({ apiKey: KEY });
    client = new UploadPostClient({ apiKey: KEY, baseUrl: mock.baseUrl, sleep: async () => {}, maxReadRetries: 0, writeTimeoutMs: 400 });
  });
  afterAll(async () => {
    await mock.close();
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-sw-" } } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-" } } });
    mock.state.profiles = defaultProfiles();
    mock.state.publications.clear();
    mock.state.jobs.clear();
    mock.state.idempotency.clear();
    mock.state.requests.length = 0;
    mock.setDelay(0);
    mock.setResponseDelay(0);
    vi.mocked(enqueuePublishingJob).mockClear();
  });

  describe("hand-off", () => {
    it("hands an upcoming target to the provider scheduler: job_id stored, external_id correlated, target stays SCHEDULED in Socialith", async () => {
      const { target } = await setup(3 * HOUR);
      const s = await sweep();
      expect(s.handedOff).toBe(1);
      const p = await pub(target.id);
      expect(p).toMatchObject({ mode: "PROVIDER_SCHEDULED", status: "SCHEDULED_AT_PROVIDER", generation: 1 });
      expect(p.providerJobId).toBeTruthy();
      const job = mock.state.jobs.get(p.providerJobId!)!;
      expect(job.externalId).toBe(`socialith:target:${target.id}:g1`);
      expect(job.platforms).toEqual(["tiktok"]);
      expect(Math.abs(new Date(job.scheduledDate).getTime() - p.scheduledFor!.getTime())).toBeLessThan(1000);
      expect((await tgt(target.id)).status).toBe("SCHEDULED");
      expect(mock.state.publications.size).toBe(0); // nothing is published now
    });

    it("is idempotent: sweeping again creates no second provider job", async () => {
      const { target } = await setup(3 * HOUR);
      await sweep();
      await sweep();
      await sweep();
      expect(mock.state.jobs.size).toBe(1);
      expect(await prisma.uploadPostPublication.count({ where: { contentTargetId: target.id } })).toBe(1);
    });

    it("does nothing when hand-off is disabled, outside the window, too close to the due time, or for native destinations", async () => {
      const off = await setup(3 * HOUR);
      expect((await sweep({ config: { ...CONFIG, handoffEnabled: false } })).handedOff).toBe(0);
      await prisma.content.update({ where: { id: off.content.id }, data: { scheduledAt: new Date(Date.now() + 5 * 24 * HOUR) } });
      expect((await sweep()).handedOff).toBe(0); // beyond the 48 h window
      await prisma.content.update({ where: { id: off.content.id }, data: { scheduledAt: new Date(Date.now() + 5 * MIN) } });
      expect((await sweep()).handedOff).toBe(0); // inside the 10-minute minimum lead
      await prisma.socialAccount.update({ where: { id: off.social.id }, data: { publishingProvider: "NATIVE" } });
      await prisma.content.update({ where: { id: off.content.id }, data: { scheduledAt: new Date(Date.now() + 3 * HOUR) } });
      expect((await sweep()).handedOff).toBe(0);
      expect(mock.state.jobs.size).toBe(0);
      expect(await prisma.uploadPostPublication.count({ where: { contentTargetId: off.target.id } })).toBe(0);
    });

    it("keeps ownership when the media URLs are not durable (presigned URLs would expire before the provider runs the job)", async () => {
      const { target } = await setup(3 * HOUR);
      const s = await sweep({ resolveMaterial: async () => ({ ...durable, durable: false }) });
      expect(s).toMatchObject({ handedOff: 0, handoffSkipped: 1 });
      expect(mock.state.jobs.size).toBe(0);
      expect(await prisma.uploadPostPublication.count({ where: { contentTargetId: target.id } })).toBe(0);
    });

    it("keeps ownership when the destination is not ready (reconnect required)", async () => {
      const { target, org } = await setup(3 * HOUR);
      await prisma.uploadPostConnectedAccount.updateMany({ where: { organizationId: org.id, platform: "tiktok" }, data: { status: "REAUTH_REQUIRED" } });
      expect((await sweep()).handedOff).toBe(0);
      expect(await prisma.uploadPostPublication.count({ where: { contentTargetId: target.id } })).toBe(0);
    });

    it("a permanent provider refusal degrades to Socialith ownership (publication FAILED, target still fires normally)", async () => {
      const { target } = await setup(3 * HOUR);
      mock.script({ status: 400, body: { success: false, message: "bad media" } });
      await sweep();
      expect((await pub(target.id)).status).toBe("FAILED");
      expect(mock.state.jobs.size).toBe(0);
      // Socialith's own job now fires it:
      await prisma.content.update({ where: { id: (await tgt(target.id)).contentId }, data: { scheduledAt: new Date(Date.now() - 1000) } });
      await processContentScheduling({ data: { contentId: (await tgt(target.id)).contentId } } as never);
      expect((await tgt(target.id)).status).toBe("PUBLISHING");
      expect(enqueuePublishingJob).toHaveBeenCalledWith(target.id);
    });

    it("an unknown hand-off outcome is resolved by external_id: the provider job is ADOPTED, never duplicated", async () => {
      const { target } = await setup(3 * HOUR);
      mock.setResponseDelay(900); // created at the provider, answer too late for our 400 ms write timeout
      await sweep();
      expect((await pub(target.id)).status).toBe("UNKNOWN_OUTCOME");
      await new Promise((r) => setTimeout(r, 1000));
      expect(mock.state.jobs.size).toBe(1);
      mock.setResponseDelay(0);
      const s = await sweep();
      expect(s.handoffsResolved).toBe(1);
      expect(await pub(target.id)).toMatchObject({ status: "SCHEDULED_AT_PROVIDER", providerJobId: [...mock.state.jobs.keys()][0] });
      expect(mock.state.jobs.size).toBe(1);
    });

    it("an unknown outcome that never reached the provider is released back to Socialith and handed off cleanly next time", async () => {
      const { target } = await setup(3 * HOUR);
      mock.setDelay(900); // the request is held BEFORE the provider handles it and our client gives up first
      await sweep();
      expect((await pub(target.id)).status).toBe("UNKNOWN_OUTCOME");
      await new Promise((r) => setTimeout(r, 1100)); // the held request finishes at the double...
      mock.setDelay(0);
      mock.state.jobs.clear(); // ...and we model "the provider never created anything"
      const s = await sweep();
      // released (nothing at the provider) and, in the same sweep, handed off again as a NEW generation
      expect(s).toMatchObject({ handoffsResolved: 1, handedOff: 1 });
      expect(await pub(target.id)).toMatchObject({ status: "SCHEDULED_AT_PROVIDER", generation: 2 });
      expect(mock.state.jobs.size).toBe(1);
      expect([...mock.state.jobs.values()][0]!.externalId).toBe(`socialith:target:${target.id}:g2`);
    });
  });

  describe("one owner at a time (never scheduled in both systems)", () => {
    it("the Socialith scheduling job does NOT fire a provider-owned target", async () => {
      const { target, content } = await setup(3 * HOUR);
      await sweep();
      await prisma.content.update({ where: { id: content.id }, data: { scheduledAt: new Date(Date.now() - 1000) } }); // Socialith's job fires at the due time
      await processContentScheduling({ data: { contentId: content.id } } as never);
      expect((await tgt(target.id)).status).toBe("SCHEDULED");
      expect((await cnt(content.id)).status).toBe("SCHEDULED");
      expect(enqueuePublishingJob).not.toHaveBeenCalled();
    });

    it("in mixed content only the Socialith-owned target fires; the provider-owned one is left alone", async () => {
      const { target, content, org } = await setup(3 * HOUR);
      await sweep();
      const native = await prisma.socialAccount.create({ data: { organizationId: org.id, platform: "INSTAGRAM", externalAccountId: "n1", handle: "n", displayName: "n" } });
      const other = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: native.id, status: "SCHEDULED" } });
      await prisma.content.update({ where: { id: content.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
      await processContentScheduling({ data: { contentId: content.id } } as never);
      expect((await tgt(other.id)).status).toBe("PUBLISHING");
      expect((await tgt(target.id)).status).toBe("SCHEDULED");
      expect(enqueuePublishingJob).toHaveBeenCalledTimes(1);
      expect(enqueuePublishingJob).toHaveBeenCalledWith(other.id);
    });

    it("the reconciler neither re-creates a Socialith job for, nor stale-holds, a provider-owned target", async () => {
      const { target, content } = await setup(3 * HOUR);
      await sweep();
      const port = fakePort();
      let summary = await reconcileScheduling({ db: prisma, port, config: reconcileConfig, log: silent });
      expect(summary.skippedProviderOwned).toBe(1);
      expect(port.calls).toEqual([]);
      // far past due and "stale": a Socialith-owned target would be held; the provider-owned one must not be
      await prisma.content.update({ where: { id: content.id }, data: { scheduledAt: new Date(Date.now() - 5 * HOUR) } });
      summary = await reconcileScheduling({ db: prisma, port, config: reconcileConfig, log: silent });
      expect(summary).toMatchObject({ skippedProviderOwned: 1, heldStale: 0 });
      expect((await tgt(target.id)).status).toBe("SCHEDULED");
      expect((await cnt(content.id)).status).toBe("SCHEDULED");
    });

    it("stale hold of mixed content fails only the Socialith-owned targets and leaves the content SCHEDULED for the provider's", async () => {
      const { target, content, org } = await setup(3 * HOUR);
      await sweep();
      const native = await prisma.socialAccount.create({ data: { organizationId: org.id, platform: "INSTAGRAM", externalAccountId: "n2", handle: "n", displayName: "n" } });
      const other = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: native.id, status: "SCHEDULED" } });
      await prisma.content.update({ where: { id: content.id }, data: { scheduledAt: new Date(Date.now() - 5 * HOUR) } });
      const summary = await reconcileScheduling({ db: prisma, port: fakePort(), config: reconcileConfig, log: silent });
      expect(summary.heldStale).toBe(1);
      expect((await tgt(other.id)).status).toBe("FAILED");
      expect((await tgt(target.id)).status).toBe("SCHEDULED");
      expect((await cnt(content.id)).status).toBe("SCHEDULED");
    });

    it("targets of normal (non hand-off) content behave exactly as before", async () => {
      const { target, content } = await setup(3 * HOUR);
      await prisma.socialAccount.updateMany({ where: { id: (await tgt(target.id)).socialAccountId }, data: { publishingProvider: "NATIVE" } });
      const port = fakePort();
      const summary = await reconcileScheduling({ db: prisma, port, config: reconcileConfig, log: silent });
      expect(summary).toMatchObject({ skippedProviderOwned: 0, schedulingJobsEnqueued: 1 });
      expect(port.calls).toContain(`enqueue-scheduling:${content.id}`);
    });
  });

  describe("drift: Socialith stays the master", () => {
    it("rescheduling in Socialith edits the provider job (no second job)", async () => {
      const { target, content } = await setup(3 * HOUR);
      await sweep();
      const jobId = (await pub(target.id)).providerJobId!;
      const newTime = new Date(Date.now() + 5 * HOUR);
      await prisma.content.update({ where: { id: content.id }, data: { scheduledAt: newTime } });
      const s = await sweep();
      expect(s.driftRescheduled).toBe(1);
      expect(mock.state.jobs.get(jobId)!.scheduledDate).toBe(newTime.toISOString());
      expect(mock.state.jobs.size).toBe(1);
      expect(Math.abs((await pub(target.id)).scheduledFor!.getTime() - newTime.getTime())).toBeLessThan(1000);
    });

    it("unscheduling / removing the target in Socialith cancels the provider job", async () => {
      const { target, content } = await setup(3 * HOUR);
      await sweep();
      const jobId = (await pub(target.id)).providerJobId!;
      await prisma.content.update({ where: { id: content.id }, data: { status: "DRAFT", scheduledAt: null } });
      const s = await sweep();
      expect(s.driftCancelled).toBe(1);
      expect(mock.state.jobs.get(jobId)!.status).toBe("cancelled");
      expect((await pub(target.id)).status).toBe("CANCELLED");
    });

    it("moving the time outside the window releases the provider job back to Socialith", async () => {
      const { target, content } = await setup(3 * HOUR);
      await sweep();
      const jobId = (await pub(target.id)).providerJobId!;
      await prisma.content.update({ where: { id: content.id }, data: { scheduledAt: new Date(Date.now() + 10 * 24 * HOUR) } });
      await sweep();
      expect(mock.state.jobs.get(jobId)!.status).toBe("cancelled");
      expect((await pub(target.id)).status).toBe("CANCELLED");
      expect((await tgt(target.id)).status).toBe("SCHEDULED"); // Socialith's own schedule is untouched
    });

    it("a cancel that the provider reports as already gone is fine; a job running right now (409) is left alone and retried later", async () => {
      const { target, content } = await setup(3 * HOUR);
      await sweep();
      const jobId = (await pub(target.id)).providerJobId!;
      mock.state.jobs.get(jobId)!.status = "cancelled"; // vanished at the provider
      await prisma.content.update({ where: { id: content.id }, data: { status: "DRAFT", scheduledAt: null } });
      await sweep();
      expect((await pub(target.id)).status).toBe("CANCELLED");

      const b = await setup(3 * HOUR);
      await sweep();
      const jb = (await pub(b.target.id)).providerJobId!;
      mock.state.jobs.get(jb)!.inProgress = true;
      await prisma.content.update({ where: { id: b.content.id }, data: { scheduledAt: new Date(Date.now() + 6 * HOUR) } });
      const s = await sweep();
      expect(s.driftRescheduled).toBe(0); // 409: deferred, nothing changed
      expect((await pub(b.target.id)).status).toBe("SCHEDULED_AT_PROVIDER");
    });
  });

  describe("status synchronization of provider-run jobs", () => {
    it("when the provider has run the job, the target becomes PUBLISHED and the content rolls up", async () => {
      const { target, content } = await setup(3 * HOUR);
      await sweep();
      const p = await pub(target.id);
      mock.runScheduledJob(p.providerJobId!);
      await prisma.uploadPostPublication.update({ where: { id: p.id }, data: { scheduledFor: new Date(Date.now() - MIN), lastSyncedAt: null } }); // due time passed
      await prisma.content.update({ where: { id: content.id }, data: { status: "PUBLISHING" } });
      const s = await sweep();
      expect(s.statusFinalized).toBe(1);
      expect(await tgt(target.id)).toMatchObject({ status: "PUBLISHED", externalPostUrl: expect.stringContaining("https://example.test/tiktok/") });
      expect((await pub(target.id)).status).toBe("COMPLETED");
      expect((await cnt(content.id)).status).toBe("PUBLISHED");
    });

    it("a provider-run job that fails marks the target and content FAILED", async () => {
      const { target, content } = await setup(3 * HOUR);
      await sweep();
      const p = await pub(target.id);
      mock.runScheduledJob(p.providerJobId!, "failed");
      await prisma.uploadPostPublication.update({ where: { id: p.id }, data: { scheduledFor: new Date(Date.now() - MIN), lastSyncedAt: null } });
      await sweep();
      expect((await tgt(target.id)).status).toBe("FAILED");
      expect((await cnt(content.id)).status).toBe("FAILED");
    });

    it("a job still unresolved long after its due time is failed as UNCONFIRMED (not left hanging, not republished)", async () => {
      const { target } = await setup(3 * HOUR);
      await sweep();
      const p = await pub(target.id);
      await prisma.uploadPostPublication.update({ where: { id: p.id }, data: { scheduledFor: new Date(Date.now() - 7 * HOUR), lastSyncedAt: null } });
      const s = await sweep();
      expect(s.unconfirmedFailed).toBe(1);
      expect((await pub(target.id)).lastErrorKind).toBe("UNCONFIRMED");
      expect((await tgt(target.id)).status).toBe("FAILED");
      expect(mock.state.publications.size).toBe(0); // never re-sent
    });

    it("in-flight immediate publications are reconciled by the sweep too (no webhook, no poll needed)", async () => {
      const { target } = await setup(3 * HOUR);
      await prisma.contentTarget.update({ where: { id: target.id }, data: { status: "PUBLISHING" } });
      const created = await prisma.uploadPostPublication.create({
        data: {
          organizationId: (await tgt(target.id)) && (await prisma.content.findUniqueOrThrow({ where: { id: (await tgt(target.id)).contentId } })).organizationId,
          contentTargetId: target.id, mode: "IMMEDIATE", status: "PROCESSING", externalId: `socialith:target:${target.id}:g1`, requestId: `sl-${target.id}-g1`, idempotencyKey: "k", profileUsername: "acme_music", platform: "tiktok",
        },
      });
      mock.state.publications.set(created.requestId, { requestId: created.requestId, externalId: created.externalId, profile: "acme_music", platforms: ["tiktok"], status: "pending", results: [], fields: {}, mediaType: "video" });
      mock.finishPublication(created.requestId, "completed");
      const s = await sweep();
      expect(s.statusFinalized).toBe(1);
      expect((await tgt(target.id)).status).toBe("PUBLISHED");
    });
  });
});
