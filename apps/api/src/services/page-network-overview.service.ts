import { prisma } from "@socialith/database";
import type { Prisma } from "@socialith/database";
import { EDITORIAL_FORMATS, STARTER_CATEGORIES } from "@socialith/publishing";
import type { SafeUser } from "../types/auth.js";
import { PAGE_INCLUDE, MAPPING_STATE_LABELS, buildMapping, canSeeInternal, missingFields, type MappingState } from "./page-network-common.js";

const isDemo = (m: Prisma.JsonValue | null) => typeof m === "object" && m !== null && !Array.isArray(m) && (m as Record<string, unknown>).seed === true;

/** Publishing Destinations that no page uses yet: real, not demo, not an individual creator's account. */
async function unlinkedDestinations(actor: SafeUser) {
  const rows = await prisma.socialAccount.findMany({
    where: { organizationId: actor.organizationId, managedPage: null, OR: [{ uploadPostAccount: null }, { uploadPostAccount: { is: { creatorId: null } } }] },
    include: { uploadPostAccount: { select: { status: true, profile: { select: { username: true } } } } },
    orderBy: [{ platform: "asc" }, { handle: "asc" }],
    take: 300,
  });
  const internal = canSeeInternal(actor);
  return rows
    .filter((r) => !isDemo(r.providerMetadata))
    .map((r) => ({ id: r.id, platform: r.platform, handle: r.handle, displayName: r.displayName, status: r.status, provider: r.publishingProvider, providerAccountStatus: r.uploadPostAccount?.status ?? null, profile: internal ? (r.uploadPostAccount?.profile.username ?? null) : null }));
}

export async function getOverview(actor: SafeUser) {
  const org = actor.organizationId;
  const [categories, pages, groups, unlinked, categoryRows, campaignsWithPages] = await Promise.all([
    prisma.pageCategory.findMany({ where: { organizationId: org }, select: { id: true, name: true, slug: true, status: true } }),
    prisma.managedPage.findMany({ where: { organizationId: org }, include: PAGE_INCLUDE, orderBy: [{ name: "asc" }] }),
    prisma.pageGroup.findMany({ where: { organizationId: org }, select: { id: true, name: true, status: true, _count: { select: { members: true } } } }),
    unlinkedDestinations(actor),
    prisma.pageCategory.count({ where: { organizationId: org, status: "ACTIVE" } }),
    prisma.campaign.count({ where: { organizationId: org, OR: [{ pages: { some: {} } }, { pageGroups: { some: {} } }] } }),
  ]);

  const active = pages.filter((p) => p.status === "ACTIVE");
  const byPlatform: Record<string, number> = {};
  const byCategory = new Map<string, { id: string | null; name: string; count: number }>();
  const mapping: Record<MappingState, number> = { NO_DESTINATION: 0, READY: 0, REAUTH_REQUIRED: 0, DISCONNECTED: 0, UNAVAILABLE: 0 };
  const attention: { id: string; name: string; platform: string | null; state: MappingState; stateLabel: string; reasons: string[] }[] = [];
  for (const p of active) {
    byPlatform[p.platform ?? "UNSET"] = (byPlatform[p.platform ?? "UNSET"] ?? 0) + 1;
    const key = p.category?.id ?? "none";
    const entry = byCategory.get(key) ?? { id: p.category?.id ?? null, name: p.category?.name ?? "No category", count: 0 };
    entry.count++;
    byCategory.set(key, entry);
    const m = buildMapping(p, false);
    mapping[m.state]++;
    const incomplete = missingFields(p);
    if (m.linked && m.state !== "READY") attention.push({ id: p.id, name: p.name, platform: p.platform, state: m.state, stateLabel: m.stateLabel, reasons: m.issues.map((i) => i.message) });
    else if (incomplete.length > 0 && !attention.some((a) => a.id === p.id)) attention.push({ id: p.id, name: p.name, platform: p.platform, state: m.state, stateLabel: m.stateLabel, reasons: [`Incomplete page profile: missing ${incomplete.join(", ")}.`] });
  }

  const missingStarters = STARTER_CATEGORIES.filter((s) => !categories.some((c) => c.slug === s.slug || c.name.toLowerCase() === s.name.toLowerCase())).map((s) => s.name);

  return {
    counts: {
      categories: categoryRows,
      pages: active.length,
      archivedPages: pages.length - active.length,
      groups: groups.filter((g) => g.status === "ACTIVE").length,
      campaignsWithPages,
      unlinkedDestinations: unlinked.length,
    },
    byPlatform,
    byCategory: [...byCategory.values()].sort((a, b) => a.name.localeCompare(b.name)),
    mapping: { ...mapping, labels: MAPPING_STATE_LABELS },
    attention: attention.slice(0, 20),
    groups: groups.filter((g) => g.status === "ACTIVE").map((g) => ({ id: g.id, name: g.name, pageCount: g._count.members })),
    missingStarterCategories: missingStarters,
    formats: EDITORIAL_FORMATS.length,
  };
}

/** Every page's connection to its destination in full, plus the destinations that no page uses yet. */
export async function getMapping(actor: SafeUser, q: { state?: MappingState; platform?: "TIKTOK" | "INSTAGRAM" | "YOUTUBE"; status: "ACTIVE" | "ARCHIVED" | "ALL" }) {
  const rows = await prisma.managedPage.findMany({
    where: { organizationId: actor.organizationId, ...(q.status === "ALL" ? {} : { status: q.status }), ...(q.platform ? { platform: q.platform } : {}) },
    include: PAGE_INCLUDE,
    orderBy: [{ name: "asc" }],
  });
  const internal = canSeeInternal(actor);
  const all = rows.map((p) => ({
    page: { id: p.id, name: p.name, status: p.status, platform: p.platform, username: p.username, category: p.category ? { id: p.category.id, name: p.category.name } : null },
    mapping: buildMapping(p, internal),
  }));
  const counts: Record<MappingState, number> = { NO_DESTINATION: 0, READY: 0, REAUTH_REQUIRED: 0, DISCONNECTED: 0, UNAVAILABLE: 0 };
  for (const r of all) counts[r.mapping.state]++;
  return {
    items: q.state ? all.filter((r) => r.mapping.state === q.state) : all,
    counts,
    unlinkedDestinations: await unlinkedDestinations(actor),
  };
}
