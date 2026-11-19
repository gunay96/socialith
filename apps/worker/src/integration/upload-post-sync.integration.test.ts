import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { UploadPostClient, defaultProfiles, startMockUploadPostServer, type MockUploadPostHandle } from "@socialith/upload-post";
import { syncUploadPostProfiles } from "../upload-post/sync.js";

/**
 * REAL MySQL + the real HTTP client against the in-memory Upload-Post contract double (never the live service):
 * profile / account synchronization, stable identity, mapping preservation and failure safety.
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;
const silent = { info: () => undefined, warn: () => undefined };

let mock: MockUploadPostHandle;
let client: UploadPostClient;
const KEY = "test-key-0000000000";

async function makeOrg() {
  return prisma.organization.create({ data: { name: "IT UP", slug: `it-up-${randomUUID().slice(0, 8)}` } });
}
const sync = (organizationId: string, c: UploadPostClient = client) =>
  syncUploadPostProfiles({ db: prisma, client: c, log: silent }, organizationId, "MANUAL");

const tiktokOf = (profile: string) => mock.state.profiles.find((p) => p.username === profile)!.social_accounts.tiktok as Record<string, unknown>;

async function accountOf(organizationId: string, username: string, platform: string) {
  const profile = await prisma.uploadPostProfile.findUniqueOrThrow({ where: { organizationId_username: { organizationId, username } } });
  return prisma.uploadPostConnectedAccount.findUniqueOrThrow({ where: { profileId_platform: { profileId: profile.id, platform } } });
}

/** Enables an account as a Publishing Destination the way the API will (SocialAccount linked 1:1). */
async function enableDestination(organizationId: string, username: string, platform: "tiktok" | "instagram" | "youtube") {
  const acc = await accountOf(organizationId, username, platform);
  const social = await prisma.socialAccount.create({
    data: {
      organizationId,
      platform: platform.toUpperCase() as "TIKTOK",
      externalAccountId: acc.providerAccountId,
      handle: acc.handle ?? "",
      displayName: acc.displayName ?? "",
      publishingProvider: "UPLOAD_POST",
    },
  });
  await prisma.uploadPostConnectedAccount.update({ where: { id: acc.id }, data: { socialAccountId: social.id } });
  return social;
}

suite("Upload-Post synchronization (real MySQL, contract double)", () => {
  beforeAll(async () => {
    mock = await startMockUploadPostServer({ apiKey: KEY });
    client = new UploadPostClient({ apiKey: KEY, baseUrl: mock.baseUrl, sleep: async () => {} });
  });
  afterAll(async () => {
    await mock.close();
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-up-" } } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-" } } });
    mock.state.profiles = defaultProfiles();
    mock.state.profileLimit = 225;
    mock.state.plan = "Business";
  });

  it("imports profiles and accounts, records the provider-reported plan and limit, and a sync run", async () => {
    const org = await makeOrg();
    const out = await sync(org.id);
    expect(out.status).toBe("SUCCEEDED");
    if (out.status !== "SUCCEEDED") return;
    expect(out.summary).toMatchObject({ profilesSeen: 2, profilesCreated: 2, accountsSeen: 4, accountsCreated: 4, accountsReauth: 1 });
    expect(out.profileLimit).toBe(225); // from the provider response, not a constant
    expect(out.plan).toBe("business");

    const acme = await accountOf(org.id, "acme_music", "tiktok");
    expect(acme).toMatchObject({ providerAccountId: "-000g91dgwXgwtNwcStableOpenId1", handle: "acme.music", status: "CONNECTED" });
    expect(acme.capabilities).toContain("music");
    expect((await accountOf(org.id, "acme_music", "youtube")).status).toBe("REAUTH_REQUIRED");
    expect(await prisma.uploadPostConnectedAccount.count({ where: { organizationId: org.id } })).toBe(4);

    const run = await prisma.uploadPostSyncRun.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(run).toMatchObject({ status: "SUCCEEDED", trigger: "MANUAL", profileLimit: 225 });
  });

  it("is idempotent: repeating the sync creates no duplicates and reports no changes", async () => {
    const org = await makeOrg();
    await sync(org.id);
    const again = await sync(org.id);
    expect(again.status).toBe("SUCCEEDED");
    if (again.status === "SUCCEEDED") {
      expect(again.summary).toMatchObject({ profilesCreated: 0, profilesUpdated: 0, accountsCreated: 0, accountsUpdated: 0, profilesRemoved: 0, accountsDisconnected: 0 });
    }
    expect(await prisma.uploadPostProfile.count({ where: { organizationId: org.id } })).toBe(2);
    expect(await prisma.uploadPostConnectedAccount.count({ where: { organizationId: org.id } })).toBe(4);
  });

  it("two simultaneous syncs never create duplicate rows", async () => {
    const org = await makeOrg();
    const results = await Promise.all([sync(org.id), sync(org.id), sync(org.id)]);
    expect(results.some((r) => r.status === "SUCCEEDED")).toBe(true);
    expect(await prisma.uploadPostProfile.count({ where: { organizationId: org.id } })).toBe(2);
    expect(await prisma.uploadPostConnectedAccount.count({ where: { organizationId: org.id } })).toBe(4);
  });

  it("never touches Socialith-side mappings (managed page, creator, destination link)", async () => {
    const org = await makeOrg();
    await sync(org.id);
    const page = await prisma.managedPage.create({ data: { organizationId: org.id, name: "Acme page", slug: "acme" } });
    const creator = await prisma.creator.create({ data: { organizationId: org.id, name: "Acme Artist" } });
    const profile = await prisma.uploadPostProfile.findUniqueOrThrow({ where: { organizationId_username: { organizationId: org.id, username: "acme_music" } } });
    await prisma.uploadPostProfile.update({ where: { id: profile.id }, data: { managedPageId: page.id } });
    const social = await enableDestination(org.id, "acme_music", "tiktok");
    const acc = await accountOf(org.id, "acme_music", "tiktok");
    await prisma.uploadPostConnectedAccount.update({ where: { id: acc.id }, data: { creatorId: creator.id } });

    await sync(org.id);
    await sync(org.id);

    expect((await prisma.uploadPostProfile.findUniqueOrThrow({ where: { id: profile.id } })).managedPageId).toBe(page.id);
    const after = await accountOf(org.id, "acme_music", "tiktok");
    expect(after.creatorId).toBe(creator.id);
    expect(after.socialAccountId).toBe(social.id);
  });

  describe("identity", () => {
    it("UNCHANGED identity: a renamed public handle updates display data but keeps the stable id and the destination link", async () => {
      const org = await makeOrg();
      await sync(org.id);
      const social = await enableDestination(org.id, "acme_music", "tiktok");
      tiktokOf("acme_music").handle = "acme.renamed";
      await sync(org.id);
      const acc = await accountOf(org.id, "acme_music", "tiktok");
      expect(acc).toMatchObject({ providerAccountId: "-000g91dgwXgwtNwcStableOpenId1", handle: "acme.renamed", socialAccountId: social.id });
      const dest = await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } });
      expect(dest).toMatchObject({ status: "CONNECTED", handle: "acme.renamed", externalAccountId: "-000g91dgwXgwtNwcStableOpenId1" });
      expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "UPLOAD_POST_ACCOUNT_IDENTITY_CHANGED" } })).toBe(0);
    });

    it("CHANGED identity: the destination link is invalidated, the destination flagged ERROR, an audit row written, and history is preserved", async () => {
      const org = await makeOrg();
      await sync(org.id);
      const social = await enableDestination(org.id, "acme_music", "tiktok");
      const content = await prisma.content.create({ data: { organizationId: org.id, caption: "c", status: "PUBLISHED" } });
      const target = await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: social.id, status: "PUBLISHED", externalPostId: "old-post" } });

      tiktokOf("acme_music").username = "-000g91dgwXgwtNwcSomeoneElse9";
      const out = await sync(org.id);
      expect(out.status === "SUCCEEDED" && out.summary.identityChanges).toBe(1);

      const acc = await accountOf(org.id, "acme_music", "tiktok");
      expect(acc.providerAccountId).toBe("-000g91dgwXgwtNwcSomeoneElse9");
      expect(acc.socialAccountId).toBeNull(); // no silent carry-over of the old mapping
      const dest = await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } });
      expect(dest.status).toBe("ERROR");
      expect(dest.lastErrorMessage).toMatch(/different account/i);
      expect(dest.externalAccountId).toBe("-000g91dgwXgwtNwcStableOpenId1"); // still describes the OLD account
      // history survives
      expect(await prisma.contentTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: "PUBLISHED", externalPostId: "old-post" });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.id, action: "UPLOAD_POST_ACCOUNT_IDENTITY_CHANGED" } });
      expect(audit.metadataJson).toMatchObject({ previousProviderAccountId: "-000g91dgwXgwtNwcStableOpenId1", newProviderAccountId: "-000g91dgwXgwtNwcSomeoneElse9" });
    });

    it("the blocked state SURVIVES repeated synchronization (a second sync must not re-enable it)", async () => {
      const org = await makeOrg();
      await sync(org.id);
      const social = await enableDestination(org.id, "acme_music", "tiktok");
      tiktokOf("acme_music").username = "-000g91dgwXgwtNwcSomeoneElse9";
      await sync(org.id);
      await sync(org.id);
      await sync(org.id);
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } })).status).toBe("ERROR");
      expect((await accountOf(org.id, "acme_music", "tiktok")).socialAccountId).toBeNull();
      expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "UPLOAD_POST_ACCOUNT_IDENTITY_CHANGED" } })).toBe(1);
    });

    it("RECONNECTION after an identity change: going back to the original account relinks nothing automatically; a human re-enables it", async () => {
      const org = await makeOrg();
      await sync(org.id);
      const social = await enableDestination(org.id, "acme_music", "tiktok");
      tiktokOf("acme_music").username = "-000g91dgwXgwtNwcSomeoneElse9";
      await sync(org.id);
      tiktokOf("acme_music").username = "-000g91dgwXgwtNwcStableOpenId1"; // the original account is reconnected
      const out = await sync(org.id);
      expect(out.status === "SUCCEEDED" && out.summary.identityChanges).toBe(0); // link was already cleared: nothing to re-flag
      const acc = await accountOf(org.id, "acme_music", "tiktok");
      expect(acc.providerAccountId).toBe("-000g91dgwXgwtNwcStableOpenId1");
      expect(acc.socialAccountId).toBeNull(); // not silently re-attached
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } })).status).toBe("ERROR");
      // the explicit, human step: link it again
      await prisma.uploadPostConnectedAccount.update({ where: { id: acc.id }, data: { socialAccountId: social.id } });
      await prisma.socialAccount.update({ where: { id: social.id }, data: { status: "CONNECTED", lastErrorMessage: null } });
      await sync(org.id);
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } })).status).toBe("CONNECTED");
    });

    it("MISSING external identity: a platform entry without a stable id is 'pending', never a keyed account; a known account becomes DISCONNECTED", async () => {
      const org = await makeOrg();
      await sync(org.id);
      const social = await enableDestination(org.id, "label_two", "tiktok");
      mock.state.profiles.find((p) => p.username === "label_two")!.social_accounts.tiktok = { handle: "label.two", display_name: "Label Two" } as never; // no `username`
      await sync(org.id);
      const acc = await accountOf(org.id, "label_two", "tiktok");
      expect(acc.status).toBe("DISCONNECTED");
      expect(acc.providerAccountId).toBe("-000g91dgwXgwtNwcStableOpenId2"); // last known stable id kept, not overwritten with garbage
      const profile = await prisma.uploadPostProfile.findUniqueOrThrow({ where: { organizationId_username: { organizationId: org.id, username: "label_two" } } });
      expect(profile.pendingPlatforms).toEqual(["tiktok"]);
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } })).status).toBe("DISCONNECTED");
    });
  });

  it("flags disappearances instead of deleting, and restores them when they return", async () => {
    const org = await makeOrg();
    await sync(org.id);
    const social = await enableDestination(org.id, "acme_music", "instagram");
    mock.state.profiles = mock.state.profiles.filter((p) => p.username !== "label_two");
    delete mock.state.profiles[0]!.social_accounts.instagram;
    const out = await sync(org.id);
    expect(out.status === "SUCCEEDED" && out.summary).toMatchObject({ profilesRemoved: 1, accountsDisconnected: 2 });
    expect((await prisma.uploadPostProfile.findUniqueOrThrow({ where: { organizationId_username: { organizationId: org.id, username: "label_two" } } })).status).toBe("REMOVED");
    expect((await accountOf(org.id, "label_two", "tiktok")).status).toBe("DISCONNECTED");
    expect((await accountOf(org.id, "acme_music", "instagram")).status).toBe("DISCONNECTED");
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } })).status).toBe("DISCONNECTED");
    expect(await prisma.uploadPostProfile.count({ where: { organizationId: org.id } })).toBe(2); // nothing deleted

    mock.state.profiles = defaultProfiles();
    await sync(org.id);
    expect((await accountOf(org.id, "label_two", "tiktok")).status).toBe("CONNECTED");
    expect((await prisma.uploadPostProfile.findUniqueOrThrow({ where: { organizationId_username: { organizationId: org.id, username: "label_two" } } })).status).toBe("ACTIVE");
  });

  it("reauth-required accounts surface as REAUTH_REQUIRED and expire their destination", async () => {
    const org = await makeOrg();
    const youtube = () => mock.state.profiles[0]!.social_accounts.youtube as { reauth_required?: boolean };
    youtube().reauth_required = false;
    await sync(org.id);
    const social = await enableDestination(org.id, "acme_music", "youtube");
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } })).status).toBe("CONNECTED");
    youtube().reauth_required = true; // the token expires at the provider
    await sync(org.id);
    await sync(org.id); // repeated sync must not duplicate the audit row
    expect((await accountOf(org.id, "acme_music", "youtube")).status).toBe("REAUTH_REQUIRED");
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: social.id } })).status).toBe("EXPIRED");
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "UPLOAD_POST_ACCOUNT_REAUTH_REQUIRED" } })).toBe(1);
  });

  it("a rejected API key fails the run and changes NOTHING", async () => {
    const org = await makeOrg();
    await sync(org.id);
    const bad = new UploadPostClient({ apiKey: "wrong-key-123456789", baseUrl: mock.baseUrl, sleep: async () => {} });
    const out = await sync(org.id, bad);
    expect(out).toMatchObject({ status: "FAILED", errorKind: "AUTH" });
    expect(await prisma.uploadPostProfile.count({ where: { organizationId: org.id, status: "ACTIVE" } })).toBe(2);
    expect(await prisma.uploadPostSyncRun.count({ where: { organizationId: org.id, status: "FAILED" } })).toBe(1);
  });

  it("an empty provider answer while many profiles are known is refused as suspicious, not applied", async () => {
    const org = await makeOrg();
    const original = mock.state.profiles;
    mock.state.profiles = Array.from({ length: 6 }, (_, i) => ({ username: `bulk_${i}`, display_name: null, created_at: "2025-01-01T00:00:00", social_accounts: {} }));
    await sync(org.id);
    mock.state.profiles = [];
    const out = await sync(org.id);
    expect(out).toMatchObject({ status: "FAILED", errorKind: "SUSPICIOUS_EMPTY" });
    expect(await prisma.uploadPostProfile.count({ where: { organizationId: org.id, status: "ACTIVE" } })).toBe(6);
    mock.state.profiles = original;
  });

  it("skips while another run is in progress", async () => {
    const org = await makeOrg();
    await prisma.uploadPostSyncRun.create({ data: { organizationId: org.id, trigger: "MANUAL", status: "RUNNING" } });
    expect((await sync(org.id)).status).toBe("SKIPPED_ALREADY_RUNNING");
    expect(await prisma.uploadPostProfile.count({ where: { organizationId: org.id } })).toBe(0);
  });
});
