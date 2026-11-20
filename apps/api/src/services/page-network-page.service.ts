import { prisma } from "@socialith/database";
import type { Prisma } from "@socialith/database";
import { checkOriginality, checkPageRules, effectiveText, type EditorialProfile, type PlatformKey, type ValidationIssue } from "@socialith/publishing";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { getEffectiveSettings } from "./publishing-common.js";
import { requireAssignableCategory } from "./page-network-category.service.js";
import {
  PAGE_INCLUDE,
  asProfile,
  badRequest,
  buildMapping,
  canSeeInternal,
  conflict,
  conflictOrRethrow,
  normalizeUsername,
  notFound,
  profileToStore,
  resolveForPage,
  slugify,
  toPageListItem,
  type PageRow,
} from "./page-network-common.js";

type Platform = "TIKTOK" | "INSTAGRAM" | "YOUTUBE";

async function loadPage(actor: SafeUser, id: string): Promise<PageRow> {
  const page = await prisma.managedPage.findFirst({ where: { id, organizationId: actor.organizationId }, include: PAGE_INCLUDE });
  if (!page) throw notFound("Page");
  return page;
}

// ---------------------------------------------------------------------------------------------- list

export interface ListPagesQuery {
  page: number;
  pageSize: number;
  search?: string;
  status: "ACTIVE" | "ARCHIVED" | "ALL";
  platform?: Platform;
  categoryId?: string;
  category?: "none";
  groupId?: string;
  campaignId?: string;
  mapping?: "LINKED" | "UNLINKED" | "PROBLEM";
}

export function pageWhere(organizationId: string, q: Omit<ListPagesQuery, "page" | "pageSize">): Prisma.ManagedPageWhereInput {
  const and: Prisma.ManagedPageWhereInput[] = [];
  if (q.search) and.push({ OR: [{ name: { contains: q.search } }, { username: { contains: q.search.replace(/^@/, "") } }, { slug: { contains: q.search } }] });
  if (q.groupId) and.push({ groupMemberships: { some: { groupId: q.groupId } } });
  if (q.campaignId) {
    // the campaign's pages: assigned directly, or members of a group assigned to it
    and.push({ OR: [{ campaignPages: { some: { campaignId: q.campaignId } } }, { groupMemberships: { some: { group: { status: "ACTIVE", campaigns: { some: { campaignId: q.campaignId } } } } } }] });
  }
  return {
    organizationId,
    ...(q.status === "ALL" ? {} : { status: q.status }),
    ...(q.platform ? { platform: q.platform } : {}),
    ...(q.categoryId ? { categoryId: q.categoryId } : q.category === "none" ? { categoryId: null } : {}),
    ...(q.mapping === "LINKED" ? { socialAccountId: { not: null } } : q.mapping === "UNLINKED" ? { socialAccountId: null } : q.mapping === "PROBLEM" ? { socialAccountId: { not: null } } : {}),
    ...(and.length ? { AND: and } : {}),
  };
}

export async function listPages(actor: SafeUser, q: ListPagesQuery) {
  const where = pageWhere(actor.organizationId, q);
  const orderBy: Prisma.ManagedPageOrderByWithRelationInput[] = [{ name: "asc" }, { id: "asc" }];
  if (q.mapping === "PROBLEM") {
    // a problem is derived from the live destination state, which no column holds: filter after loading (a network has
    // tens to low hundreds of pages), then page the result
    const all = await prisma.managedPage.findMany({ where, include: PAGE_INCLUDE, orderBy });
    const items = all.map((p) => toPageListItem(p, actor)).filter((p) => p.mapping.state !== "READY");
    return { items: items.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: items.length, page: q.page, pageSize: q.pageSize };
  }
  const [rows, total] = await Promise.all([
    prisma.managedPage.findMany({ where, include: PAGE_INCLUDE, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.managedPage.count({ where }),
  ]);
  return { items: rows.map((p) => toPageListItem(p, actor)), total, page: q.page, pageSize: q.pageSize };
}

// ---------------------------------------------------------------------------------------------- detail

export async function getPage(actor: SafeUser, id: string) {
  const page = await loadPage(actor, id);
  const internal = canSeeInternal(actor);
  const { identity } = resolveForPage(page);
  const mapping = buildMapping(page, internal);

  const [directCampaigns, viaGroups, publications] = await Promise.all([
    prisma.campaignPage.findMany({ where: { pageId: id }, include: { campaign: { select: { id: true, name: true, status: true } } } }),
    prisma.campaignPageGroup.findMany({
      where: { group: { status: "ACTIVE", members: { some: { pageId: id } } }, campaign: { organizationId: actor.organizationId } },
      include: { campaign: { select: { id: true, name: true, status: true } }, group: { select: { id: true, name: true } } },
    }),
    page.socialAccountId ? publicationStats(page.socialAccountId) : Promise.resolve(null),
  ]);
  const campaigns = new Map<string, { id: string; name: string; status: string; via: string[] }>();
  for (const c of directCampaigns) campaigns.set(c.campaign.id, { ...c.campaign, via: ["direct"] });
  for (const c of viaGroups) {
    const e = campaigns.get(c.campaign.id) ?? { ...c.campaign, via: [] as string[] };
    e.via.push(`group: ${c.group.name}`);
    campaigns.set(c.campaign.id, e);
  }

  return {
    ...toPageListItem(page, actor),
    editorialIdentity: page.editorialIdentity,
    profile: asProfile(page.profile),
    internalNotes: internal ? page.internalNotes : null,
    category: page.category ? { id: page.category.id, name: page.category.name, status: page.category.status, language: page.category.language } : null,
    groups: page.groupMemberships.map((m) => ({ id: m.group.id, name: m.group.name, status: m.group.status })),
    identity,
    mapping,
    campaigns: [...campaigns.values()],
    publications,
  };
}

async function publicationStats(socialAccountId: string) {
  const [byStatus, last] = await Promise.all([
    prisma.contentTarget.groupBy({ by: ["status"], where: { socialAccountId }, _count: { _all: true } }),
    prisma.contentTarget.aggregate({ where: { socialAccountId, status: "PUBLISHED" }, _max: { publishedAt: true } }),
  ]);
  const counts: Record<string, number> = { PENDING: 0, SCHEDULED: 0, PUBLISHING: 0, PUBLISHED: 0, FAILED: 0 };
  for (const r of byStatus) counts[r.status] = r._count._all;
  return { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts, lastPublishedAt: last._max.publishedAt };
}

// ---------------------------------------------------------------------------------------------- link rules

/**
 * Whether a Publishing Destination may be linked to a page. The destination must already exist (it is created by the
 * Upload-Post enable-destination flow, never here), be of the page's platform, not be a demo/seed account, not already
 * serve another page, and not belong to an individual creator (creators and thematic pages stay separate entities).
 */
async function assertLinkable(actor: SafeUser, socialAccountId: string, platform: Platform | null, pageId: string | null) {
  const social = await prisma.socialAccount.findFirst({
    where: { id: socialAccountId, organizationId: actor.organizationId },
    include: { uploadPostAccount: { select: { creatorId: true } }, managedPage: { select: { id: true, name: true, status: true } } },
  });
  if (!social) throw notFound("Publishing destination");
  if (!platform) throw conflict("Choose the page's platform first: a destination can only be linked to a page of the same platform.");
  if (social.platform !== platform) throw conflict(`That destination is a ${social.platform.toLowerCase()} account; this page is on ${platform.toLowerCase()}.`);
  const meta = social.providerMetadata;
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta) && (meta as Record<string, unknown>).seed === true) {
    throw conflict("That is a demo/seed account and can never publish, so it cannot be a page's destination.");
  }
  if (social.managedPage && social.managedPage.id !== pageId) {
    throw conflict(`That destination already belongs to the page "${social.managedPage.name}"${social.managedPage.status === "ARCHIVED" ? " (archived — unlink it there first)" : ""}. A destination serves one page.`);
  }
  if (social.uploadPostAccount?.creatorId) {
    throw conflict("That account is assigned to an individual creator. Creators and thematic pages are kept separate: remove the creator assignment first if this account really is a page.");
  }
  return social;
}

// ---------------------------------------------------------------------------------------------- create / edit

export interface PageCreateInput {
  name: string;
  slug?: string;
  platform: Platform;
  username: string;
  profileUrl?: string | null;
  categoryId?: string | null;
  description?: string | null;
  targetAudience?: string | null;
  language?: string | null;
  editorialIdentity?: string | null;
  profile?: EditorialProfile | null;
  internalNotes?: string | null;
  socialAccountId?: string | null;
}

async function uniqueSlug(organizationId: string, name: string, platform: Platform, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const base = slugify(name);
  if (base.length < 2) throw badRequest("Could not derive a slug from the name; provide one.");
  const candidates = [base, `${base}-${platform.toLowerCase()}`];
  for (let i = 2; i < 50; i++) candidates.push(`${base}-${platform.toLowerCase()}-${i}`);
  const taken = new Set((await prisma.managedPage.findMany({ where: { organizationId, slug: { in: candidates } }, select: { slug: true } })).map((p) => p.slug));
  const free = candidates.find((c) => !taken.has(c));
  if (!free) throw conflict("Could not find a free slug for this name; provide one.");
  return free;
}

function uniqueViolation(err: unknown): never {
  const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? "");
  if (target.includes("username")) conflictOrRethrow(err, "A page with that username is already registered on this platform.");
  if (target.includes("social_account")) conflictOrRethrow(err, "That destination was just linked to another page.");
  return conflictOrRethrow(err, "A page with that slug already exists.");
}

export async function createPage(actor: SafeUser, input: PageCreateInput) {
  if (input.categoryId) await requireAssignableCategory(actor.organizationId, input.categoryId);
  if (input.socialAccountId) await assertLinkable(actor, input.socialAccountId, input.platform, null);
  const slug = await uniqueSlug(actor.organizationId, input.name, input.platform, input.slug);
  try {
    const row = await prisma.managedPage.create({
      data: {
        organizationId: actor.organizationId,
        name: input.name,
        slug,
        platform: input.platform,
        username: normalizeUsername(input.username),
        profileUrl: input.profileUrl ?? null,
        categoryId: input.categoryId ?? null,
        description: input.description ?? null,
        targetAudience: input.targetAudience ?? null,
        language: input.language ?? null,
        editorialIdentity: input.editorialIdentity ?? null,
        profile: profileToStore(input.profile),
        internalNotes: input.internalNotes ?? null,
        socialAccountId: input.socialAccountId ?? null,
      },
    });
    await createAuditLog({
      organizationId: actor.organizationId,
      userId: actor.id,
      action: "MANAGED_PAGE_CREATED",
      targetType: "ManagedPage",
      targetId: row.id,
      metadata: { platform: row.platform, categoryId: row.categoryId, linkedDestination: row.socialAccountId },
    });
    if (row.socialAccountId) {
      await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MANAGED_PAGE_DESTINATION_LINKED", targetType: "ManagedPage", targetId: row.id, metadata: { from: null, to: row.socialAccountId } });
    }
    return getPage(actor, row.id);
  } catch (err) {
    return uniqueViolation(err);
  }
}

export interface PageUpdateInput {
  name?: string;
  platform?: Platform;
  username?: string;
  profileUrl?: string | null;
  categoryId?: string | null;
  description?: string | null;
  targetAudience?: string | null;
  language?: string | null;
  internalNotes?: string | null;
}

export async function updatePage(actor: SafeUser, id: string, input: PageUpdateInput) {
  const page = await loadPage(actor, id);
  if (page.status === "ARCHIVED") throw conflict("This page is archived. Restore it before editing.");
  if (input.platform && input.platform !== page.platform && page.socialAccountId) {
    throw conflict("The platform cannot change while a publishing destination is linked. Unlink the destination first.");
  }
  if (input.categoryId) await requireAssignableCategory(actor.organizationId, input.categoryId, page.categoryId);
  const data: Prisma.ManagedPageUncheckedUpdateInput = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.username !== undefined ? { username: normalizeUsername(input.username) } : {}),
    ...(input.profileUrl !== undefined ? { profileUrl: input.profileUrl } : {}),
    ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.targetAudience !== undefined ? { targetAudience: input.targetAudience } : {}),
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.internalNotes !== undefined ? { internalNotes: input.internalNotes } : {}),
  };
  try {
    await prisma.managedPage.update({ where: { id }, data });
  } catch (err) {
    return uniqueViolation(err);
  }
  // the notes are not copied into the audit log; only which fields changed
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MANAGED_PAGE_UPDATED", targetType: "ManagedPage", targetId: id, metadata: { fields: Object.keys(data), ...(input.categoryId !== undefined ? { categoryFrom: page.categoryId, categoryTo: input.categoryId } : {}) } });
  return getPage(actor, id);
}

export async function updateIdentity(actor: SafeUser, id: string, input: { editorialIdentity?: string | null; profile?: EditorialProfile | null }) {
  const page = await loadPage(actor, id);
  if (page.status === "ARCHIVED") throw conflict("This page is archived. Restore it before editing.");
  // a full replacement of the page's own overrides: whatever is left out inherits from the category again
  await prisma.managedPage.update({ where: { id }, data: { editorialIdentity: input.editorialIdentity ?? null, profile: profileToStore(input.profile) } });
  await createAuditLog({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: "MANAGED_PAGE_IDENTITY_UPDATED",
    targetType: "ManagedPage",
    targetId: id,
    metadata: { hadOverrides: Boolean(page.editorialIdentity || page.profile), hasOverrides: Boolean(input.editorialIdentity || (input.profile && Object.keys(input.profile).length > 0)) },
  });
  return getIdentity(actor, id);
}

export async function getIdentity(actor: SafeUser, id: string, groupId?: string) {
  const page = await loadPage(actor, id);
  const { identity, group } = resolveForPage(page, groupId);
  return {
    pageId: page.id,
    appliedGroup: group,
    category: page.category ? { id: page.category.id, name: page.category.name, status: page.category.status } : null,
    own: { editorialIdentity: page.editorialIdentity, language: page.language, profile: asProfile(page.profile) },
    effective: identity,
  };
}

// ---------------------------------------------------------------------------------------------- archive

export async function archivePage(actor: SafeUser, id: string) {
  const page = await loadPage(actor, id);
  if (page.status === "ARCHIVED") return getPage(actor, id);
  await prisma.managedPage.update({ where: { id }, data: { status: "ARCHIVED" } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MANAGED_PAGE_ARCHIVED", targetType: "ManagedPage", targetId: id, metadata: { name: page.name, groups: page.groupMemberships.length, linkedDestination: page.socialAccountId } });
  return getPage(actor, id);
}

export async function restorePage(actor: SafeUser, id: string) {
  const page = await loadPage(actor, id);
  if (page.status === "ACTIVE") return getPage(actor, id);
  await prisma.managedPage.update({ where: { id }, data: { status: "ACTIVE" } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "MANAGED_PAGE_RESTORED", targetType: "ManagedPage", targetId: id, metadata: { name: page.name } });
  return getPage(actor, id);
}

// ---------------------------------------------------------------------------------------------- destination

export async function setDestination(actor: SafeUser, id: string, socialAccountId: string | null) {
  const page = await loadPage(actor, id);
  if (page.status === "ARCHIVED") throw conflict("This page is archived. Restore it before changing its destination.");
  if (socialAccountId === page.socialAccountId) return getPage(actor, id); // idempotent
  if (socialAccountId) await assertLinkable(actor, socialAccountId, page.platform, id);
  try {
    await prisma.managedPage.update({ where: { id }, data: { socialAccountId } });
  } catch (err) {
    return uniqueViolation(err);
  }
  await createAuditLog({
    organizationId: actor.organizationId,
    userId: actor.id,
    action: socialAccountId ? "MANAGED_PAGE_DESTINATION_LINKED" : "MANAGED_PAGE_DESTINATION_UNLINKED",
    targetType: "ManagedPage",
    targetId: id,
    metadata: { from: page.socialAccountId, to: socialAccountId },
  });
  return getPage(actor, id);
}

/** Destinations this page could be linked to: same platform, not demo, not serving another page, not a creator's. */
export async function destinationCandidates(actor: SafeUser, id: string) {
  const page = await loadPage(actor, id);
  if (!page.platform) return { items: [], reason: "Set the page's platform first." };
  const rows = await prisma.socialAccount.findMany({
    where: { organizationId: actor.organizationId, platform: page.platform, managedPage: null, OR: [{ uploadPostAccount: null }, { uploadPostAccount: { is: { creatorId: null } } }] },
    include: { uploadPostAccount: { select: { status: true, profile: { select: { username: true, status: true } } } } },
    orderBy: [{ handle: "asc" }],
    take: 200,
  });
  const internal = canSeeInternal(actor);
  const isDemo = (m: Prisma.JsonValue | null) => typeof m === "object" && m !== null && !Array.isArray(m) && (m as Record<string, unknown>).seed === true;
  return {
    items: rows
      .filter((r) => !isDemo(r.providerMetadata))
      .map((r) => ({ id: r.id, platform: r.platform, handle: r.handle, displayName: r.displayName, status: r.status, provider: r.publishingProvider, providerAccountStatus: r.uploadPostAccount?.status ?? null, profile: internal ? (r.uploadPostAccount?.profile.username ?? null) : null })),
    reason: null,
  };
}

// ---------------------------------------------------------------------------------------------- page rules

/** The effective captions of the destination's most recent posts that went out or are going out (newest first). */
export async function recentDestinationTexts(socialAccountId: string, platform: PlatformKey, take: number, excludeTargetId?: string): Promise<{ id: string; text: string | null }[]> {
  if (take <= 0) return [];
  const targets = await prisma.contentTarget.findMany({
    where: { socialAccountId, status: { in: ["PUBLISHED", "SCHEDULED", "PUBLISHING"] }, ...(excludeTargetId ? { id: { not: excludeTargetId } } : {}) },
    include: { content: { select: { caption: true, variations: { select: { platform: true, caption: true, title: true } } } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
  return targets.map((t) => {
    const variation = t.content.variations.find((v) => v.platform === platform) ?? null;
    return { id: t.id, text: effectiveText({ captionOverride: t.captionOverride, titleOverride: t.titleOverride, variationCaption: variation?.caption ?? null, variationTitle: variation?.title ?? null, contentCaption: t.content.caption }).caption };
  });
}

/** Checks a text against the page's rules and its own recent posts. Advisory: nothing is stored or published. */
export async function checkText(actor: SafeUser, id: string, text: string, groupId?: string) {
  const page = await loadPage(actor, id);
  const { identity, group } = resolveForPage(page, groupId);
  const settings = await getEffectiveSettings(actor.organizationId);
  const previous = page.socialAccountId && page.platform ? await recentDestinationTexts(page.socialAccountId, page.platform, identity.originality.lookbackPosts) : [];
  const issues: ValidationIssue[] = [...checkPageRules(identity, text), ...checkOriginality(identity, text, previous, settings.similarityThresholdPct)];
  return {
    pageId: id,
    appliedGroup: group,
    ok: !issues.some((i) => i.severity === "ERROR"),
    issues,
    comparedWith: previous.length,
    note: page.socialAccountId ? null : "This page has no publishing destination yet, so there are no earlier posts to compare with.",
  };
}

/** Page-rule issues for ONE publication (used by the Publishing Center's validation). Returns [] when the destination serves no active page. */
export async function pageRuleIssuesFor(args: { socialAccountId: string; platform: PlatformKey; text: string | null; excludeTargetId: string; fallbackThresholdPct: number }): Promise<ValidationIssue[]> {
  const page = await prisma.managedPage.findFirst({ where: { socialAccountId: args.socialAccountId, status: "ACTIVE" }, include: PAGE_INCLUDE });
  if (!page) return [];
  const { identity } = resolveForPage(page);
  const previous = await recentDestinationTexts(args.socialAccountId, args.platform, identity.originality.lookbackPosts, args.excludeTargetId);
  return [...checkPageRules(identity, args.text), ...checkOriginality(identity, args.text, previous, args.fallbackThresholdPct)].map((i) => ({ ...i, message: `[${page.name}] ${i.message}` }));
}
