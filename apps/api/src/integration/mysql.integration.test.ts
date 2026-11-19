import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { decryptToken, hashPassword, parseEncryptionKey } from "@socialith/auth";
import { authenticateWithPassword } from "../services/auth.service.js";
import { connectAccount } from "../services/social-account.service.js";
import { listCampaigns } from "../repositories/campaign.repository.js";
import { createContent, listContent } from "../repositories/content.repository.js";
import { listSocialAccounts, upsertSocialAccount } from "../repositories/social-account.repository.js";
import { listSounds } from "../repositories/sound.repository.js";
import { getConnectionSummary, createPlatformConnection } from "../repositories/platform-connection.repository.js";
import type { SafeUser } from "../types/auth.js";

/**
 * REAL MySQL integration tests: real server, the real committed migration,
 * the real Prisma client and the real repositories/services — no mocks.
 * Skipped (not failed) when MYSQL_INTEGRATION_URL is unset; run through
 * `pnpm --filter @socialith/api test:mysql` (docs/DATABASE_MYSQL.md).
 */
const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;

const PAGE = { page: 1, pageSize: 50 };
const createdOrganizationIds: string[] = [];

async function makeOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `IT ${label}`, slug: `it-${label}-${randomUUID().slice(0, 8)}` },
  });
  createdOrganizationIds.push(org.id);
  return org;
}

async function makeUser(organizationId: string, email: string, passwordHash = "x") {
  return prisma.user.create({
    data: { organizationId, name: "IT User", email, passwordHash, role: "OWNER", status: "ACTIVE" },
  });
}

function asSafeUser(user: { id: string; organizationId: string; name: string; email: string }): SafeUser {
  return {
    id: user.id,
    organizationId: user.organizationId,
    name: user.name,
    email: user.email,
    role: "OWNER",
    status: "ACTIVE",
    lastLoginAt: null,
    createdAt: new Date(),
  };
}

suite("MySQL integration (real server, real migration, real code)", () => {
  afterAll(async () => {
    // Cascading deletes also exercise the FK graph on the way out.
    if (createdOrganizationIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    await prisma.$disconnect();
  });

  describe("server and schema facts", () => {
    it("reports the server version (recorded for the compatibility matrix)", async () => {
      const rows = await prisma.$queryRaw<{ v: string }[]>`SELECT VERSION() AS v`;
      const version = rows[0]?.v ?? "";
      console.info(`[mysql-integration] server version: ${version}`);
      expect(version).toMatch(/^(8\.0|8\.4|5\.7)\./);
    });

    it("every application table is InnoDB with utf8mb4_unicode_ci", async () => {
      const rows = await prisma.$queryRaw<{ t: string; c: string; e: string }[]>`
        SELECT table_name AS t, table_collation AS c, engine AS e
        FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name <> '_prisma_migrations'`;
      expect(rows.length).toBeGreaterThanOrEqual(17);
      for (const row of rows) {
        expect(row.e, `${row.t} engine`).toBe("InnoDB");
        expect(row.c, `${row.t} collation`).toBe("utf8mb4_unicode_ci");
      }
    });
  });

  describe("the six case-insensitive search filters (via the real repositories)", () => {
    it("1) campaigns: name contains, any letter case", async () => {
      const org = await makeOrg("campaign-search");
      await prisma.campaign.create({ data: { organizationId: org.id, name: "Summer Release Push" } });
      await prisma.campaign.create({ data: { organizationId: org.id, name: "Winter Remix" } });
      for (const q of ["summer", "SUMMER", "sUmMeR release"]) {
        const result = await listCampaigns(org.id, { search: q, ...PAGE });
        expect(result.items.map((c) => c.name), q).toEqual(["Summer Release Push"]);
        expect(result.total).toBe(1);
      }
    });

    it("2) content: caption contains, any letter case", async () => {
      const org = await makeOrg("content-search");
      await createContent({ organizationId: org.id, caption: "Our NEW single is out now" });
      await createContent({ organizationId: org.id, caption: "Behind the scenes" });
      for (const q of ["new single", "NEW SINGLE", "Out Now"]) {
        const result = await listContent(org.id, { search: q, ...PAGE });
        expect(result.items.map((c) => c.caption), q).toEqual(["Our NEW single is out now"]);
      }
    });

    it("3+4) social accounts: handle OR displayName contains, any letter case", async () => {
      const org = await makeOrg("account-search");
      await prisma.socialAccount.create({
        data: { organizationId: org.id, platform: "TIKTOK", externalAccountId: "a1", handle: "@Socialith.Music", displayName: "Alpha Label" },
      });
      await prisma.socialAccount.create({
        data: { organizationId: org.id, platform: "INSTAGRAM", externalAccountId: "a2", handle: "@other", displayName: "Beta Records" },
      });
      const byHandle = await listSocialAccounts(org.id, { search: "SOCIALITH", ...PAGE });
      expect(byHandle.items.map((a) => a.externalAccountId)).toEqual(["a1"]);
      const byDisplayName = await listSocialAccounts(org.id, { search: "beta records", ...PAGE });
      expect(byDisplayName.items.map((a) => a.externalAccountId)).toEqual(["a2"]);
    });

    it("5+6) sounds: artist filter, and title OR artist search, any letter case", async () => {
      const org = await makeOrg("sound-search");
      await prisma.sound.create({ data: { organizationId: org.id, platform: "TIKTOK", title: "Gece Yarisi", artist: "Alroca" } });
      await prisma.sound.create({ data: { organizationId: org.id, platform: "TIKTOK", title: "Other Song", artist: "Someone Else" } });

      const byArtistFilter = await listSounds(org.id, { artist: "ALROCA", ...PAGE });
      expect(byArtistFilter.items.map((s) => s.title)).toEqual(["Gece Yarisi"]);

      const byTitle = await listSounds(org.id, { search: "gece YARISI", ...PAGE });
      expect(byTitle.items.map((s) => s.artist)).toEqual(["Alroca"]);

      const byArtistSearch = await listSounds(org.id, { search: "someone", ...PAGE });
      expect(byArtistSearch.items.map((s) => s.title)).toEqual(["Other Song"]);
    });

    it("characterization: % and _ typed into the search box act as LIKE wildcards (not escaped) — see TECHNICAL_DEBT TD-25", async () => {
      const org = await makeOrg("wildcards");
      await prisma.campaign.create({ data: { organizationId: org.id, name: "100% organic" } });
      await prisma.campaign.create({ data: { organizationId: org.id, name: "100 organic" } });
      await prisma.campaign.create({ data: { organizationId: org.id, name: "a_b" } });
      await prisma.campaign.create({ data: { organizationId: org.id, name: "axb" } });
      const names = async (q: string) => (await listCampaigns(org.id, { search: q, ...PAGE })).items.map((c) => c.name).sort();
      // Observed on MySQL 8.0/8.4 via Prisma `contains`: the wildcard is NOT neutralized.
      // Harmless to isolation (the query is parameterized and organization-scoped) but
      // surprising to users; the test pins current behavior so a future fix is a deliberate change.
      expect(await names("100%")).toEqual(["100 organic", "100% organic"]);
      expect(await names("a_b")).toEqual(["a_b", "axb"]);
    });

    it("Turkish text: case/accents fold, but dotless ı is a distinct letter (documented limitation)", async () => {
      const org = await makeOrg("turkish");
      await prisma.campaign.create({ data: { organizationId: org.id, name: "İstanbul Gecesi" } });
      await prisma.campaign.create({ data: { organizationId: org.id, name: "Güzel Kapı" } });
      const names = async (q: string) => (await listCampaigns(org.id, { search: q, ...PAGE })).items.map((c) => c.name);
      expect(await names("istanbul")).toEqual(["İstanbul Gecesi"]);
      expect(await names("ISTANBUL")).toEqual(["İstanbul Gecesi"]);
      expect(await names("guzel")).toEqual(["Güzel Kapı"]);
      expect(await names("kapı")).toEqual(["Güzel Kapı"]);
      // Characterization of current behavior, not an endorsement: "kapi" does NOT find "Kapı".
      expect(await names("kapi")).toEqual([]);
    });
  });

  describe("column types replaced during the PostgreSQL -> MySQL port", () => {
    it("stores values far beyond VARCHAR(191) without truncation (caption, URL, error text)", async () => {
      const org = await makeOrg("long-text");
      const caption = "c".repeat(5000);
      const content = await createContent({ organizationId: org.id, caption });
      expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).caption).toBe(caption);

      const url = `https://cdn.example.com/${"u".repeat(1900)}`;
      const asset = await prisma.contentAsset.create({ data: { contentId: content.id, type: "VIDEO", url } });
      expect((await prisma.contentAsset.findUniqueOrThrow({ where: { id: asset.id } })).url).toBe(url);

      const message = "e".repeat(12_000);
      const account = await prisma.socialAccount.create({
        data: { organizationId: org.id, platform: "TIKTOK", externalAccountId: "long", handle: "@l", displayName: "L", lastErrorMessage: message },
      });
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).lastErrorMessage).toBe(message);
    });

    it("PlatformConnection: long encrypted tokens and the scopes JSON array round-trip", async () => {
      const org = await makeOrg("connection");
      const account = await prisma.socialAccount.create({
        data: { organizationId: org.id, platform: "YOUTUBE", externalAccountId: "yt", handle: "@yt", displayName: "YT" },
      });
      const token = "T".repeat(1600);
      await createPlatformConnection({
        socialAccountId: account.id,
        encryptedAccessToken: token,
        scopes: ["user.info.basic", "video.list", "video.upload"],
      });
      const raw = await prisma.platformConnection.findUniqueOrThrow({ where: { socialAccountId: account.id } });
      expect(raw.encryptedAccessToken).toBe(token);
      const summary = await getConnectionSummary(account.id);
      expect(summary?.scopes).toEqual(["user.info.basic", "video.list", "video.upload"]);
      expect(summary?.hasActiveCredential).toBe(true);
    });

    it("JSON columns keep nested and non-ASCII data intact", async () => {
      const org = await makeOrg("json");
      const metadata = { note: "Şarkı çalışıyor ✓", nested: { list: [1, 2, { ok: true }], none: null } };
      const row = await prisma.auditLog.create({ data: { organizationId: org.id, action: "IT_JSON", metadataJson: metadata } });
      expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).metadataJson).toEqual(metadata);
    });
  });

  describe("constraints, relations and transactions", () => {
    it("enforces the composite unique key on social accounts (P2002)", async () => {
      const org = await makeOrg("unique-account");
      const data = { organizationId: org.id, platform: "TIKTOK" as const, externalAccountId: "dup", handle: "@d", displayName: "D" };
      await prisma.socialAccount.create({ data });
      await expect(prisma.socialAccount.create({ data })).rejects.toMatchObject({ code: "P2002" });
      // The same external id on a different platform is allowed.
      await expect(prisma.socialAccount.create({ data: { ...data, platform: "INSTAGRAM" } })).resolves.toBeTruthy();
    });

    it("user e-mail uniqueness is case-insensitive under this collation (documented behavior)", async () => {
      const org = await makeOrg("unique-email");
      await makeUser(org.id, `dup-${org.slug}@example.com`);
      await expect(makeUser(org.id, `DUP-${org.slug}@EXAMPLE.com`)).rejects.toMatchObject({ code: "P2002" });
    });

    it("cascades an organization delete through the whole FK graph", async () => {
      const org = await makeOrg("cascade");
      const user = await makeUser(org.id, `cascade-${org.slug}@example.com`);
      const account = await prisma.socialAccount.create({
        data: { organizationId: org.id, platform: "TIKTOK", externalAccountId: "c1", handle: "@c", displayName: "C" },
      });
      await createPlatformConnection({ socialAccountId: account.id, encryptedAccessToken: "tok", scopes: [] });
      const campaign = await prisma.campaign.create({ data: { organizationId: org.id, name: "C", createdById: user.id } });
      const content = await createContent({ organizationId: org.id, campaignId: campaign.id, caption: "x" });
      await prisma.contentTarget.create({ data: { contentId: content.id, socialAccountId: account.id } });

      await prisma.organization.delete({ where: { id: org.id } });

      expect(await prisma.user.count({ where: { organizationId: org.id } })).toBe(0);
      expect(await prisma.socialAccount.count({ where: { organizationId: org.id } })).toBe(0);
      expect(await prisma.platformConnection.count({ where: { socialAccountId: account.id } })).toBe(0);
      expect(await prisma.campaign.count({ where: { organizationId: org.id } })).toBe(0);
      expect(await prisma.contentTarget.count({ where: { contentId: content.id } })).toBe(0);
    });

    it("rolls back a failed transaction completely (InnoDB)", async () => {
      const org = await makeOrg("rollback");
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.campaign.create({ data: { organizationId: org.id, name: "should vanish" } });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await prisma.campaign.count({ where: { organizationId: org.id } })).toBe(0);
    });

    it("concurrent OAuth-style upserts of the same account never duplicate rows", async () => {
      const org = await makeOrg("upsert-race");
      const input = { organizationId: org.id, platform: "TIKTOK" as const, externalAccountId: "race", handle: "@r", displayName: "R" };
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => upsertSocialAccount(input)));
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      // MySQL has no native Prisma upsert, so a lost race may surface as P2002 —
      // that is the only acceptable failure, and it is reported, not hidden.
      for (const r of rejected) expect(r.reason).toMatchObject({ code: "P2002" });
      console.info(`[mysql-integration] concurrent upserts: ${results.length - rejected.length} ok, ${rejected.length} lost-race P2002`);
      expect(await prisma.socialAccount.count({ where: { organizationId: org.id } })).toBe(1);
    });
  });

  describe("real application flows on MySQL", () => {
    it("login: real scrypt hash + case-insensitive e-mail lookup + unknown user", async () => {
      const org = await makeOrg("login");
      const email = `owner-${org.slug}@example.com`;
      await makeUser(org.id, email, await hashPassword("correct horse battery staple"));

      const ok = await authenticateWithPassword(`  ${email.toUpperCase()}  `, "correct horse battery staple");
      expect(ok.outcome).toBe("success");
      const wrong = await authenticateWithPassword(email, "wrong password");
      expect(wrong.outcome).toBe("invalid_password");
      const unknown = await authenticateWithPassword(`nobody-${org.slug}@example.com`, "whatever");
      expect(unknown.outcome).toBe("unknown_email");
    });

    it("OAuth connect: encrypts a 1200-char token, stores scopes, reconnect updates in place", async () => {
      const org = await makeOrg("connect");
      const user = await makeUser(org.id, `connect-${org.slug}@example.com`);
      const actor = asSafeUser(user);
      const accessToken = "A".repeat(1200);

      const account = await connectAccount(actor, {
        platform: "TIKTOK",
        externalAccountId: "open-id-1",
        handle: "@connected",
        displayName: "Connected",
        accessToken,
        refreshToken: "R".repeat(300),
        scopes: ["user.info.basic", "video.upload"],
      });

      const stored = await prisma.platformConnection.findUniqueOrThrow({ where: { socialAccountId: account.id } });
      expect(stored.encryptedAccessToken && stored.encryptedAccessToken.length).toBeGreaterThan(1500);
      expect(decryptToken(stored.encryptedAccessToken ?? "", parseEncryptionKey("ab".repeat(32)))).toBe(accessToken);

      const again = await connectAccount(actor, {
        platform: "TIKTOK",
        externalAccountId: "open-id-1",
        handle: "@connected2",
        displayName: "Connected 2",
        accessToken: "B".repeat(900),
        scopes: ["user.info.basic", "video.list", "video.upload"],
      });
      expect(again.id).toBe(account.id);
      expect(await prisma.socialAccount.count({ where: { organizationId: org.id } })).toBe(1);
      expect((await getConnectionSummary(account.id))?.scopes).toEqual(["user.info.basic", "video.list", "video.upload"]);
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).handle).toBe("@connected2");
    });
  });
});
