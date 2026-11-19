import { PrismaClient } from "@prisma/client";
import { hashPassword, encryptToken, parseEncryptionKey } from "@socialith/auth";

const prisma = new PrismaClient();

// ⚠️ DEVELOPMENT-ONLY SEED PASSWORD — not a production credential.
// This value exists solely so a local/dev database has one working login
// row out of the box. It is hardcoded, publicly visible in this file, and
// must never be reused for a real environment — anyone deploying to
// staging/production must create the owner account (or set a real
// password) through the actual auth flow once it exists, not by relying
// on this constant. Never stored in plaintext regardless: it's hashed
// below with the same Argon2id implementation (@socialith/auth) used by
// the real login/invitation-acceptance/password-reset code paths, so
// local dev data is hashed exactly the way production data will be.
const DEV_ONLY_SEED_PASSWORD_NOT_FOR_PRODUCTION = "change-me-in-dev";

/**
 * Phase 04 — there is no real TikTok/Instagram/YouTube OAuth flow yet
 * (see schema.prisma's SocialAccount comment), so this is the *only*
 * place SocialAccount/PlatformConnection rows get created right now,
 * purely so the /accounts list/detail UI has real, non-empty data to
 * render against locally. The "access tokens" below are obviously fake
 * strings, but they go through the real AES-256-GCM encryptToken() —
 * this exercises the actual encrypt/decrypt round trip end-to-end, not a
 * stubbed-out one.
 */
const SAMPLE_ACCOUNTS = [
  {
    platform: "TIKTOK" as const,
    externalAccountId: "tiktok-ext-001",
    handle: "@socialith.music",
    displayName: "Socialith Music (TikTok)",
    followerCount: 128_400,
    status: "CONNECTED" as const,
    fakeAccessToken: "dev-fake-tiktok-access-token-001",
  },
  {
    platform: "INSTAGRAM" as const,
    externalAccountId: "instagram-ext-001",
    handle: "@socialith.music",
    displayName: "Socialith Music (Instagram)",
    followerCount: 84_120,
    status: "CONNECTED" as const,
    fakeAccessToken: "dev-fake-instagram-access-token-001",
  },
  {
    platform: "YOUTUBE" as const,
    externalAccountId: "youtube-ext-001",
    handle: "@SocialithMusic",
    displayName: "Socialith Music (YouTube)",
    followerCount: 41_950,
    status: "EXPIRED" as const,
    lastErrorMessage: "Access token expired; reconnect required.",
    fakeAccessToken: "dev-fake-youtube-access-token-001",
  },
  {
    platform: "TIKTOK" as const,
    externalAccountId: "tiktok-ext-002",
    handle: "@socialith.label2",
    displayName: "Label Two Artist (TikTok)",
    followerCount: 9_870,
    status: "ERROR" as const,
    lastErrorMessage: "Publishing scope was revoked by the account owner.",
    fakeAccessToken: "dev-fake-tiktok-access-token-002",
  },
  {
    platform: "INSTAGRAM" as const,
    externalAccountId: "instagram-ext-002",
    handle: "@label2.artist",
    displayName: "Label Two Artist (Instagram)",
    followerCount: 15_230,
    status: "DISCONNECTED" as const,
    // Disconnected accounts hold no live credential — see
    // apps/api/src/services/social-account.service.ts's disconnectAccount.
    fakeAccessToken: null,
  },
];

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: "socialith-internal" },
    update: {},
    create: {
      name: "Socialith Internal",
      slug: "socialith-internal",
      timezone: "Europe/Istanbul",
      language: "tr",
    },
  });

  const owner = await prisma.user.upsert({
    where: { email: "owner@socialith.local" },
    update: {},
    create: {
      organizationId: org.id,
      name: "Socialith Owner",
      email: "owner@socialith.local",
      passwordHash: await hashPassword(DEV_ONLY_SEED_PASSWORD_NOT_FOR_PRODUCTION),
      role: "OWNER",
      status: "ACTIVE",
    },
  });

  const rawEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!rawEncryptionKey) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set — required to seed sample PlatformConnection rows. See .env.example.",
    );
  }
  const encryptionKey = parseEncryptionKey(rawEncryptionKey);

  const createdAccounts: { id: string; platform: string; status: string }[] = [];

  for (const sample of SAMPLE_ACCOUNTS) {
    const account = await prisma.socialAccount.upsert({
      where: {
        organizationId_platform_externalAccountId: {
          organizationId: org.id,
          platform: sample.platform,
          externalAccountId: sample.externalAccountId,
        },
      },
      update: {},
      create: {
        organizationId: org.id,
        platform: sample.platform,
        externalAccountId: sample.externalAccountId,
        handle: sample.handle,
        displayName: sample.displayName,
        followerCount: sample.followerCount,
        status: sample.status,
        lastErrorMessage: "lastErrorMessage" in sample ? sample.lastErrorMessage : null,
        connectedById: owner.id,
        // Marks this as DEMO data with fake credentials: apps/worker's
        // publishing processor refuses to publish for any account carrying
        // `seed: true` (publishing/demo-guard.ts), so seeded scheduled
        // content can never reach a real platform API.
        providerMetadata: { seed: true },
      },
    });

    if (sample.fakeAccessToken) {
      await prisma.platformConnection.upsert({
        where: { socialAccountId: account.id },
        update: {},
        create: {
          socialAccountId: account.id,
          encryptedAccessToken: encryptToken(sample.fakeAccessToken, encryptionKey),
          scopes: ["read", "publish"],
        },
      });
    } else {
      // The DISCONNECTED sample: a connection row that already went
      // through disconnectAccount's credential-nulling — proves that
      // shape too, not just the happy path.
      await prisma.platformConnection.upsert({
        where: { socialAccountId: account.id },
        update: {},
        create: {
          socialAccountId: account.id,
          encryptedAccessToken: null,
          scopes: [],
          revokedAt: new Date(),
        },
      });
    }

    createdAccounts.push({ id: account.id, platform: account.platform, status: account.status });
  }

  await seedCampaignAndContent(org.id, owner.id, createdAccounts);

  console.log("Seed complete:", { organization: org.slug, socialAccounts: SAMPLE_ACCOUNTS.length });
}

/**
 * Phase 05 — there is no real content-creation UI flow producing this
 * data yet either (the real /content pages create rows through the real
 * API, but nothing drives them automatically) — this dev-only seed just
 * gives the /campaigns and /content list/detail pages non-empty data to
 * render locally, same role as SAMPLE_ACCOUNTS above.
 */
async function seedCampaignAndContent(
  organizationId: string,
  ownerId: string,
  accounts: { id: string; platform: string; status: string }[],
) {
  // No natural unique key on Campaign besides `id` — find-or-create by
  // (organizationId, name) instead, so re-running the seed doesn't
  // duplicate it.
  const campaign =
    (await prisma.campaign.findFirst({ where: { organizationId, name: "New Album Launch" } })) ??
    (await prisma.campaign.create({
      data: {
        organizationId,
        name: "New Album Launch",
        description: "Cross-platform push for the new single across every connected account.",
        status: "ACTIVE",
        createdById: ownerId,
      },
    }));

  // Targeting isn't restricted to CONNECTED accounts by the real API
  // either (see services/content-target.service.ts's assignTargets) — a
  // target can be assigned before its account is reconnected, as long as
  // it's ready by the time real publishing (Phase 08) runs. All sample
  // accounts are used here so this demo data doesn't silently go empty
  // if a previous session's testing left every sample account
  // disconnected.
  const targetAccountIds = accounts.map((a) => a.id);

  // Content 1 — scheduled, with variations/assets/targets, so the detail
  // page has something real in every section.
  const existingScheduled = await prisma.content.findFirst({
    where: { organizationId, campaignId: campaign.id, caption: { startsWith: "Our new single is out" } },
  });
  const scheduledContent =
    existingScheduled ??
    (await prisma.content.create({
      data: {
        organizationId,
        campaignId: campaign.id,
        caption: "Our new single is out now — link in bio!",
        status: "SCHEDULED",
        scheduledAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 2), // 2 days out
        createdById: ownerId,
      },
    }));

  await prisma.contentVariation.upsert({
    where: { contentId_platform: { contentId: scheduledContent.id, platform: "INSTAGRAM" } },
    update: {},
    create: {
      contentId: scheduledContent.id,
      platform: "INSTAGRAM",
      caption: "Our new single is out now 🎶 link in bio! #newmusic #socialith",
      metadata: { hashtags: ["newmusic", "socialith"] },
    },
  });
  await prisma.contentVariation.upsert({
    where: { contentId_platform: { contentId: scheduledContent.id, platform: "TIKTOK" } },
    update: {},
    create: {
      contentId: scheduledContent.id,
      platform: "TIKTOK",
      caption: "new single just dropped 🔥",
      metadata: { hashtags: ["newmusic", "fyp"] },
    },
  });
  await prisma.contentVariation.upsert({
    where: { contentId_platform: { contentId: scheduledContent.id, platform: "YOUTUBE" } },
    update: {},
    create: {
      contentId: scheduledContent.id,
      platform: "YOUTUBE",
      title: "Our New Single — Official Release",
      caption: "Stream the new single everywhere now. Subscribe for more.",
    },
  });

  const existingAssetCount = await prisma.contentAsset.count({ where: { contentId: scheduledContent.id } });
  if (existingAssetCount === 0) {
    await prisma.contentAsset.create({
      data: {
        contentId: scheduledContent.id,
        type: "VIDEO",
        url: "https://placeholder.socialith.dev/dev-only/sample-video.mp4",
        metadata: { note: "dev-only placeholder reference, no real file" },
      },
    });
    await prisma.contentAsset.create({
      data: {
        contentId: scheduledContent.id,
        type: "THUMBNAIL",
        platform: "YOUTUBE",
        url: "https://placeholder.socialith.dev/dev-only/sample-thumbnail.jpg",
      },
    });
  }

  if (targetAccountIds.length > 0) {
    await prisma.contentTarget.createMany({
      data: targetAccountIds.map((socialAccountId) => ({
        contentId: scheduledContent.id,
        socialAccountId,
        status: "SCHEDULED" as const,
        scheduledAt: scheduledContent.scheduledAt,
      })),
      skipDuplicates: true,
    });
  }

  // Content 2 — a plain draft, no campaign, no targets yet: exercises
  // the empty states the list/detail UI needs to handle correctly.
  const existingDraft = await prisma.content.findFirst({
    where: { organizationId, caption: { startsWith: "Behind the scenes" } },
  });
  if (!existingDraft) {
    await prisma.content.create({
      data: {
        organizationId,
        caption: "Behind the scenes from the studio session (draft — not yet targeted or scheduled).",
        status: "DRAFT",
        createdById: ownerId,
      },
    });
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
