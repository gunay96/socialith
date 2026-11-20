import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { UploadPostClient } from "@socialith/upload-post";
import { syncUploadPostProfiles } from "../upload-post/sync.js";

/**
 * LIVE, READ-ONLY verification of profile synchronization against the real Upload-Post service.
 *
 * NOT part of CI and NOT run by `pnpm test` / `pnpm test:integration` (different file suffix, own config):
 *   UPLOAD_POST_LIVE_TEST=1 UPLOAD_POST_API_KEY=... MYSQL_INTEGRATION_URL=... pnpm --filter @socialith/worker test:live-readonly
 *
 * It sends exactly three GET requests (/uploadposts/me, /uploadposts/users twice — once directly, once inside the
 * sync) and writes ONLY into a throwaway organization of the local test database. It cannot publish, create,
 * edit or delete anything at the provider: the client methods used here are getMe and listProfiles. The API key
 * is never printed; the report is sanitized (no usernames, handles or e-mail).
 */
const enabled = process.env.UPLOAD_POST_LIVE_TEST === "1" && Boolean(process.env.UPLOAD_POST_API_KEY) && Boolean(process.env.MYSQL_INTEGRATION_URL);
const suite = enabled ? describe : describe.skip;
const silent = { info: () => undefined, warn: () => undefined };
const slug = `it-live-${randomUUID().slice(0, 8)}`;

suite("LIVE read-only: Upload-Post profile synchronization", () => {
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { slug: { startsWith: "it-live-" } } });
    await prisma.$disconnect();
  });

  it("syncs exactly what the provider reports — never more accounts than it returned — and is idempotent", async () => {
    const client = new UploadPostClient({ apiKey: process.env.UPLOAD_POST_API_KEY! });
    const me = await client.getMe();
    const list = await client.listProfiles();
    const org = await prisma.organization.create({ data: { name: "IT live read-only", slug } });

    const out = await syncUploadPostProfiles({ db: prisma, client, log: silent }, org.id, "MANUAL");
    expect(out.status).toBe("SUCCEEDED");
    if (out.status !== "SUCCEEDED") return;

    const providerAccounts = list.profiles.flatMap((p) => p.accounts);
    expect(out.summary.profilesSeen).toBe(list.profiles.length);
    expect(out.summary.accountsSeen).toBe(providerAccounts.length);
    expect(out.plan).toBe(list.plan);
    expect(out.profileLimit).toBe(list.profileLimit);

    expect(await prisma.uploadPostProfile.count({ where: { organizationId: org.id } })).toBe(list.profiles.length);
    const rows = await prisma.uploadPostConnectedAccount.findMany({ where: { organizationId: org.id } });
    expect(rows).toHaveLength(providerAccounts.length); // no account is ever simulated
    for (const row of rows) expect(providerAccounts.some((a) => a.platform === row.platform && a.providerAccountId === row.providerAccountId)).toBe(true);
    expect(await prisma.socialAccount.count({ where: { organizationId: org.id } })).toBe(0); // sync never creates destinations

    const again = await syncUploadPostProfiles({ db: prisma, client, log: silent }, org.id, "MANUAL");
    expect(again.status === "SUCCEEDED" && again.summary).toMatchObject({ profilesCreated: 0, profilesUpdated: 0, accountsCreated: 0, accountsUpdated: 0, accountsDisconnected: 0, profilesRemoved: 0 });

    const byPlatform: Record<string, number> = {};
    for (const a of providerAccounts) byPlatform[a.platform] = (byPlatform[a.platform] ?? 0) + 1;
    process.stdout.write(
      `\nLIVE READ-ONLY SYNC REPORT (sanitized)\n` +
        `  /me plan: ${me.plan}   /users plan: ${list.plan}   profile limit: ${list.profileLimit}\n` +
        `  profiles: ${list.profiles.length}   blocked: ${list.profiles.filter((p) => p.blocked).length}   pending platforms: ${list.profiles.reduce((n, p) => n + p.pendingPlatforms.length, 0)}\n` +
        `  connected accounts: ${providerAccounts.length} ${JSON.stringify(byPlatform)}   needing reauthorization: ${providerAccounts.filter((a) => a.reauthRequired).length}\n` +
        `  rows written locally: profiles ${out.summary.profilesCreated}, accounts ${out.summary.accountsCreated}   second run changes: none\n`,
    );
  });
});
