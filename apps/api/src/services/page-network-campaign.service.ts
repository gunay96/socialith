import { prisma } from "@socialith/database";
import type { Prisma } from "@socialith/database";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import type { SafeUser } from "../types/auth.js";
import { PAGE_INCLUDE, conflict, notFound, toPageListItem } from "./page-network-common.js";

async function loadCampaign(actor: SafeUser, id: string) {
  const c = await prisma.campaign.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true, name: true, status: true } });
  if (!c) throw notFound("Campaign");
  return c;
}

/**
 * The pages a campaign runs on: those assigned directly plus the active members of the groups assigned to it. A page
 * that is reachable both ways appears once, with both reasons. This is a relationship record only - it does not publish
 * anything and does not restrict where content may be sent (that stays per publication, approved in the Publishing Center).
 */
export async function getCampaignPages(actor: SafeUser, campaignId: string) {
  const campaign = await loadCampaign(actor, campaignId);
  const [direct, groupLinks] = await Promise.all([
    prisma.campaignPage.findMany({ where: { campaignId }, include: { page: { include: PAGE_INCLUDE } }, orderBy: [{ assignedAt: "asc" }] }),
    prisma.campaignPageGroup.findMany({
      where: { campaignId },
      include: { group: { include: { members: { include: { page: { include: PAGE_INCLUDE } } } } } },
      orderBy: [{ assignedAt: "asc" }],
    }),
  ]);

  type Via = { kind: "direct" } | { kind: "group"; groupId: string; groupName: string };
  type Entry = { page: (typeof direct)[number]["page"]; via: Via[] };
  const effective = new Map<string, Entry>();
  const add = (page: Entry["page"], via: Via) => {
    const e = effective.get(page.id) ?? { page, via: [] };
    e.via.push(via);
    effective.set(page.id, e);
  };
  for (const d of direct) add(d.page, { kind: "direct" });
  for (const g of groupLinks) {
    if (g.group.status !== "ACTIVE") continue; // an archived group no longer carries pages into the campaign
    for (const m of g.group.members) add(m.page, { kind: "group", groupId: g.group.id, groupName: g.group.name });
  }

  const effectiveItems = [...effective.values()]
    .filter((e) => e.page.status === "ACTIVE")
    .map((e) => ({ ...toPageListItem(e.page, actor), via: e.via }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const byCategory: Record<string, { name: string; count: number }> = {};
  for (const p of effectiveItems) (byCategory[p.category?.id ?? "none"] ??= { name: p.category?.name ?? "No category", count: 0 }).count++;

  return {
    campaign,
    directPages: direct.map((d) => ({ ...toPageListItem(d.page, actor), assignedAt: d.assignedAt })),
    groups: groupLinks.map((g) => ({ id: g.group.id, name: g.group.name, status: g.group.status, pageCount: g.group.members.filter((m) => m.page.status === "ACTIVE").length, assignedAt: g.assignedAt })),
    effectivePages: effectiveItems,
    byCategory: Object.values(byCategory).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function assign(actor: SafeUser, campaignId: string, input: { pageIds?: string[]; groupIds?: string[] }) {
  await loadCampaign(actor, campaignId);
  const pageIds = [...new Set(input.pageIds ?? [])];
  const groupIds = [...new Set(input.groupIds ?? [])];

  // validate everything first: nothing is assigned if one id is wrong
  const pages = pageIds.length ? await prisma.managedPage.findMany({ where: { id: { in: pageIds }, organizationId: actor.organizationId }, select: { id: true, name: true, status: true } }) : [];
  if (pages.length !== pageIds.length) throw notFound("One of the pages");
  const archivedPages = pages.filter((p) => p.status === "ARCHIVED");
  if (archivedPages.length) throw conflict(`Archived pages cannot be assigned: ${archivedPages.map((p) => p.name).join(", ")}.`);
  const groups = groupIds.length ? await prisma.pageGroup.findMany({ where: { id: { in: groupIds }, organizationId: actor.organizationId }, select: { id: true, name: true, status: true } }) : [];
  if (groups.length !== groupIds.length) throw notFound("One of the groups");
  const archivedGroups = groups.filter((g) => g.status === "ARCHIVED");
  if (archivedGroups.length) throw conflict(`Archived groups cannot be assigned: ${archivedGroups.map((g) => g.name).join(", ")}.`);

  if (pageIds.length) {
    const have = new Set((await prisma.campaignPage.findMany({ where: { campaignId, pageId: { in: pageIds } }, select: { pageId: true } })).map((r) => r.pageId));
    const fresh = pageIds.filter((p) => !have.has(p));
    if (fresh.length) {
      await prisma.campaignPage.createMany({ data: fresh.map((pageId) => ({ campaignId, pageId })), skipDuplicates: true });
      await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "CAMPAIGN_PAGES_ASSIGNED", targetType: "Campaign", targetId: campaignId, metadata: { pageIds: fresh } });
    }
  }
  if (groupIds.length) {
    const have = new Set((await prisma.campaignPageGroup.findMany({ where: { campaignId, groupId: { in: groupIds } }, select: { groupId: true } })).map((r) => r.groupId));
    const fresh = groupIds.filter((g) => !have.has(g));
    if (fresh.length) {
      await prisma.campaignPageGroup.createMany({ data: fresh.map((groupId) => ({ campaignId, groupId })), skipDuplicates: true });
      await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "CAMPAIGN_PAGE_GROUPS_ASSIGNED", targetType: "Campaign", targetId: campaignId, metadata: { groupIds: fresh } });
    }
  }
  return getCampaignPages(actor, campaignId);
}

export async function unassignPage(actor: SafeUser, campaignId: string, pageId: string) {
  await loadCampaign(actor, campaignId);
  const link = await prisma.campaignPage.findUnique({ where: { campaignId_pageId: { campaignId, pageId } } });
  if (!link) throw notFound("That page in this campaign");
  await prisma.campaignPage.delete({ where: { id: link.id } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "CAMPAIGN_PAGE_UNASSIGNED", targetType: "Campaign", targetId: campaignId, metadata: { pageId } });
  return getCampaignPages(actor, campaignId);
}

export async function unassignGroup(actor: SafeUser, campaignId: string, groupId: string) {
  await loadCampaign(actor, campaignId);
  const link = await prisma.campaignPageGroup.findUnique({ where: { campaignId_groupId: { campaignId, groupId } } });
  if (!link) throw notFound("That group in this campaign");
  await prisma.campaignPageGroup.delete({ where: { id: link.id } });
  await createAuditLog({ organizationId: actor.organizationId, userId: actor.id, action: "CAMPAIGN_PAGE_GROUP_UNASSIGNED", targetType: "Campaign", targetId: campaignId, metadata: { groupId } });
  return getCampaignPages(actor, campaignId);
}

/**
 * The campaign's content, optionally narrowed to what is aimed at a page category (or one page): a content item is
 * included when at least one of its publication targets belongs to a matching page.
 */
export async function campaignContent(actor: SafeUser, campaignId: string, q: { page: number; pageSize: number; categoryId?: string; pageId?: string }) {
  await loadCampaign(actor, campaignId);
  const pageMatch: Prisma.ManagedPageWhereInput = { ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.pageId ? { id: q.pageId } : {}) };
  const filtered = Boolean(q.categoryId || q.pageId);
  const where: Prisma.ContentWhereInput = {
    organizationId: actor.organizationId,
    campaignId,
    ...(filtered ? { targets: { some: { socialAccount: { managedPage: { is: pageMatch } } } } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.content.findMany({
      where,
      include: { targets: { include: { socialAccount: { select: { id: true, handle: true, platform: true, managedPage: { select: { id: true, name: true, category: { select: { id: true, name: true } } } } } } } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.content.count({ where }),
  ]);
  return {
    items: rows.map((c) => ({
      id: c.id,
      caption: c.caption,
      status: c.status,
      scheduledAt: c.scheduledAt,
      pages: [
        ...new Map(
          c.targets
            .map((t) => t.socialAccount.managedPage)
            .filter((p): p is NonNullable<typeof p> => p !== null)
            .map((p) => [p.id, { id: p.id, name: p.name, category: p.category }]),
        ).values(),
      ],
      targets: c.targets.length,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}
