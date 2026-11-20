import { prisma } from "@socialith/database";
import type { Prisma } from "@socialith/database";
import type { EditorialProfile } from "@socialith/publishing";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { PAGE_INCLUDE, asProfile, badRequest, buildMapping, conflict, conflictOrRethrow, notFound, profileToStore, slugify, toPageListItem, type PageRow } from "./page-network-common.js";

type Platform = "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
type GroupRow = Awaited<ReturnType<typeof prisma.pageGroup.findFirstOrThrow>>;

const DAY = 86_400_000;

function toGroupDto(g: GroupRow, extra: Record<string, unknown> = {}) {
  return {
    id: g.id,
    name: g.name,
    slug: g.slug,
    description: g.description,
    contentPreferences: asProfile(g.contentPreferences),
    status: g.status,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    ...extra,
  };
}

async function load(actor: SafeUser, id: string) {
  const g = await prisma.pageGroup.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!g) throw notFound("Page group");
  return g;
}

/** Every page id must be one of this organization's ACTIVE pages; otherwise nothing is changed. */
async function requirePages(actor: SafeUser, pageIds: string[]): Promise<string[]> {
  const unique = [...new Set(pageIds)];
  const pages = await prisma.managedPage.findMany({ where: { id: { in: unique }, organizationId: actor.organizationId }, select: { id: true, name: true, status: true } });
  const found = new Map(pages.map((p) => [p.id, p]));
  if (unique.some((id) => !found.has(id))) throw notFound("One of the pages");
  const archived = pages.filter((p) => p.status === "ARCHIVED");
  if (archived.length > 0) throw conflict(`Archived pages cannot join a group: ${archived.map((p) => p.name).join(", ")}. Restore them first.`);
  return unique;
}

// ---------------------------------------------------------------------------------------------- statistics

async function statsFor(pages: PageRow[]) {
  const active = pages.filter((p) => p.status === "ACTIVE");
  const byPlatform: Record<string, number> = {};
  const byCategory: Record<string, { name: string; count: number }> = {};
  const mapping = { ready: 0, problem: 0, unlinked: 0 };
  for (const p of active) {
    byPlatform[p.platform ?? "UNSET"] = (byPlatform[p.platform ?? "UNSET"] ?? 0) + 1;
    const key = p.category?.id ?? "none";
    (byCategory[key] ??= { name: p.category?.name ?? "No category", count: 0 }).count++;
    const state = buildMapping(p, false).state;
    if (state === "NO_DESTINATION") mapping.unlinked++;
    else if (state === "READY") mapping.ready++;
    else mapping.problem++;
  }
  const destinationIds = active.map((p) => p.socialAccountId).filter((v): v is string => Boolean(v));
  const since = new Date(Date.now() - 30 * DAY);
  const [byStatus, last30] = destinationIds.length
    ? await Promise.all([
        prisma.contentTarget.groupBy({ by: ["status"], where: { socialAccountId: { in: destinationIds } }, _count: { _all: true } }),
        prisma.contentTarget.count({ where: { socialAccountId: { in: destinationIds }, status: "PUBLISHED", publishedAt: { gte: since } } }),
      ])
    : [[], 0];
  const statusCounts: Record<string, number> = { PENDING: 0, SCHEDULED: 0, PUBLISHING: 0, PUBLISHED: 0, FAILED: 0 };
  for (const r of byStatus) statusCounts[r.status] = r._count._all;
  return {
    pages: { total: pages.length, active: active.length, archived: pages.length - active.length },
    byPlatform,
    byCategory: Object.values(byCategory).sort((a, b) => a.name.localeCompare(b.name)),
    mapping,
    publications: { byStatus: statusCounts, publishedLast30Days: last30 },
  };
}

// ---------------------------------------------------------------------------------------------- read

export async function listGroups(actor: SafeUser, q: { status: "ACTIVE" | "ARCHIVED" | "ALL"; categoryId?: string; platform?: Platform }) {
  const memberFilter: Prisma.ManagedPageWhereInput = { ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.platform ? { platform: q.platform } : {}) };
  const filtered = Boolean(q.categoryId || q.platform);
  const groups = await prisma.pageGroup.findMany({
    where: {
      organizationId: actor.organizationId,
      ...(q.status === "ALL" ? {} : { status: q.status }),
      ...(filtered ? { members: { some: { page: memberFilter } } } : {}),
    },
    include: { members: { include: { page: { include: PAGE_INCLUDE } } } },
    orderBy: [{ name: "asc" }],
  });
  const items = await Promise.all(
    groups.map(async (g) => {
      const pages = g.members.map((m) => m.page);
      const stats = await statsFor(pages);
      return toGroupDto(g, {
        pageCount: stats.pages.active,
        stats: { pages: stats.pages, byPlatform: stats.byPlatform, mapping: stats.mapping },
        // with a filter active, the matching members are what the caller asked about
        matchingPages: filtered ? pages.filter((p) => (!q.categoryId || p.categoryId === q.categoryId) && (!q.platform || p.platform === q.platform)).length : undefined,
      });
    }),
  );
  return { items };
}

export async function getGroup(actor: SafeUser, id: string) {
  const g = await load(actor, id);
  const members = await prisma.pageGroupMember.findMany({ where: { groupId: id }, include: { page: { include: PAGE_INCLUDE } }, orderBy: [{ addedAt: "asc" }] });
  const pages = members.map((m) => m.page);
  const [stats, campaigns] = await Promise.all([
    statsFor(pages),
    prisma.campaignPageGroup.findMany({ where: { groupId: id }, include: { campaign: { select: { id: true, name: true, status: true } } } }),
  ]);
  return toGroupDto(g, {
    members: members.map((m) => ({ ...toPageListItem(m.page, actor), addedAt: m.addedAt })),
    stats,
    campaigns: campaigns.map((c) => c.campaign),
  });
}

// ---------------------------------------------------------------------------------------------- write

export interface GroupInput {
  name: string;
  slug?: string;
  description?: string | null;
  contentPreferences?: EditorialProfile | null;
  pageIds?: string[];
}

export async function createGroup(actor: SafeUser, input: GroupInput) {
  const slug = input.slug ?? slugify(input.name);
  if (slug.length < 2) throw badRequest("Could not derive a slug from the name; provide one.");
  const pageIds = input.pageIds?.length ? await requirePages(actor, input.pageIds) : [];
  try {
    const g = await prisma.pageGroup.create({
      data: {
        organizationId: actor.organizationId,
        name: input.name,
        slug,
        description: input.description ?? null,
        contentPreferences: profileToStore(input.contentPreferences),
        members: { create: pageIds.map((pageId) => ({ pageId })) },
      },
    });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PAGE_GROUP_CREATED", targetType: "PageGroup", targetId: g.id, metadata: { name: g.name, pages: pageIds.length } });
    return getGroup(actor, g.id);
  } catch (err) {
    return conflictOrRethrow(err, "A group with that name or slug already exists.");
  }
}

export async function updateGroup(actor: SafeUser, id: string, input: Partial<Omit<GroupInput, "slug" | "pageIds">>) {
  const g = await load(actor, id);
  const data = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.contentPreferences !== undefined ? { contentPreferences: profileToStore(input.contentPreferences) } : {}),
  };
  try {
    await prisma.pageGroup.update({ where: { id }, data });
  } catch (err) {
    return conflictOrRethrow(err, "A group with that name already exists.");
  }
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PAGE_GROUP_UPDATED", targetType: "PageGroup", targetId: id, metadata: { fields: Object.keys(data), previousName: g.name } });
  return getGroup(actor, id);
}

export async function setGroupStatus(actor: SafeUser, id: string, status: "ACTIVE" | "ARCHIVED") {
  const g = await load(actor, id);
  if (g.status === status) return getGroup(actor, id);
  await prisma.pageGroup.update({ where: { id }, data: { status } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: status === "ARCHIVED" ? "PAGE_GROUP_ARCHIVED" : "PAGE_GROUP_RESTORED", targetType: "PageGroup", targetId: id, metadata: { name: g.name } });
  return getGroup(actor, id);
}

/** A page may belong to several groups; adding it again to the same group changes nothing. */
export async function addMembers(actor: SafeUser, id: string, pageIds: string[]) {
  const g = await load(actor, id);
  if (g.status === "ARCHIVED") throw conflict("This group is archived. Restore it before changing its pages.");
  const ids = await requirePages(actor, pageIds);
  const existing = new Set((await prisma.pageGroupMember.findMany({ where: { groupId: id, pageId: { in: ids } }, select: { pageId: true } })).map((m) => m.pageId));
  const toAdd = ids.filter((p) => !existing.has(p));
  if (toAdd.length > 0) {
    await prisma.pageGroupMember.createMany({ data: toAdd.map((pageId) => ({ groupId: id, pageId })), skipDuplicates: true });
    await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PAGE_GROUP_MEMBERS_ADDED", targetType: "PageGroup", targetId: id, metadata: { pageIds: toAdd } });
  }
  return getGroup(actor, id);
}

export async function removeMember(actor: SafeUser, id: string, pageId: string) {
  await load(actor, id);
  const member = await prisma.pageGroupMember.findUnique({ where: { groupId_pageId: { groupId: id, pageId } } });
  if (!member) throw notFound("That page in this group");
  await prisma.pageGroupMember.delete({ where: { id: member.id } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "PAGE_GROUP_MEMBER_REMOVED", targetType: "PageGroup", targetId: id, metadata: { pageId } });
  return getGroup(actor, id);
}
