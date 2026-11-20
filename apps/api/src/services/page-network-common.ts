import { hasMinimumRole } from "@socialith/auth";
import { Prisma } from "@socialith/database";
import { ERROR_CODES } from "@socialith/types";
import {
  normalizeHandle,
  resolveEditorialIdentity,
  validateDestination,
  type EditorialLayer,
  type EditorialProfile,
  type PlatformKey,
  type ResolvedIdentity,
  type ValidationIssue,
} from "@socialith/publishing";
import { ApiHttpError } from "../middleware/error-handler.js";
import type { SafeUser } from "../types/auth.js";
import { destinationFactsOf } from "./publishing-common.js";

// ---------------------------------------------------------------------------------------------- small helpers

export function slugify(value: string): string {
  return value.toLowerCase().replace(/ı/g, "i").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
}

export function notFound(what: string): ApiHttpError {
  return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, `${what} not found.`);
}
export function conflict(message: string): ApiHttpError {
  return new ApiHttpError(409, ERROR_CODES.CONFLICT, message);
}
export function badRequest(message: string): ApiHttpError {
  return new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, message);
}

/** Turns a unique-constraint violation into a readable 409; anything else is rethrown. */
export function conflictOrRethrow(err: unknown, message: string): never {
  if ((err as { code?: string }).code === "P2002") throw conflict(message);
  throw err;
}

/**
 * Internal notes and provider internals (the Upload-Post profile name) are for people who run the network (EDITOR and
 * above). Creator-owned accounts are never part of a page's data at all, so there is nothing of a creator to hide here;
 * this gate is what a future read-only creator role (Phase 8) will sit below.
 */
export function canSeeInternal(actor: Pick<SafeUser, "role">): boolean {
  return hasMinimumRole(actor.role, "EDITOR");
}

export function asProfile(json: Prisma.JsonValue | null | undefined): EditorialProfile | null {
  return json && typeof json === "object" && !Array.isArray(json) ? (json as EditorialProfile) : null;
}

/** A profile with nothing set is stored as SQL NULL, so "inherit everything" has exactly one representation. */
export function profileToStore(profile: EditorialProfile | null | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!profile) return Prisma.JsonNull;
  const cleaned = pruneEmpty(profile);
  return cleaned && Object.keys(cleaned).length > 0 ? (cleaned as Prisma.InputJsonValue) : Prisma.JsonNull;
}

function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.filter((v) => !(typeof v === "string" && v.trim() === ""));
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = pruneEmpty(v);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

export function normalizeUsername(raw: string): string {
  const handle = normalizeHandle(raw);
  if (handle.length === 0) throw badRequest("The username cannot be empty.");
  return handle;
}

// ---------------------------------------------------------------------------------------------- includes

export const PAGE_INCLUDE = {
  category: { select: { id: true, name: true, slug: true, status: true, language: true, defaultEditorialStyle: true, contentPreferences: true } },
  groupMemberships: { include: { group: { select: { id: true, name: true, slug: true, status: true, contentPreferences: true } } }, orderBy: { addedAt: "asc" } },
  socialAccount: {
    include: {
      uploadPostAccount: { include: { profile: { include: { managedPage: { select: { id: true, name: true } } } } } },
    },
  },
  uploadPostProfiles: { select: { id: true, username: true, status: true, blocked: true, lastSyncedAt: true, _count: { select: { accounts: true } } } },
} satisfies Prisma.ManagedPageInclude;

export type PageRow = Prisma.ManagedPageGetPayload<{ include: typeof PAGE_INCLUDE }>;

// ---------------------------------------------------------------------------------------------- identity

export function categoryLayer(c: PageRow["category"]): EditorialLayer | null {
  return c ? { editorialStyle: c.defaultEditorialStyle, language: c.language, profile: asProfile(c.contentPreferences) } : null;
}
export function groupLayer(g: { contentPreferences: Prisma.JsonValue | null } | null | undefined): EditorialLayer | null {
  return g ? { profile: asProfile(g.contentPreferences) } : null;
}
export function pageLayer(p: Pick<PageRow, "editorialIdentity" | "language" | "profile">): EditorialLayer {
  return { editorialStyle: p.editorialIdentity, language: p.language, profile: asProfile(p.profile) };
}

export function resolveForPage(page: PageRow, groupId?: string | null): { identity: ResolvedIdentity; group: { id: string; name: string } | null } {
  const membership = groupId ? page.groupMemberships.find((m) => m.group.id === groupId) : undefined;
  if (groupId && !membership) throw badRequest("That page is not a member of the chosen group.");
  return {
    identity: resolveEditorialIdentity({ category: categoryLayer(page.category), group: groupLayer(membership?.group), page: pageLayer(page) }),
    group: membership ? { id: membership.group.id, name: membership.group.name } : null,
  };
}

// ---------------------------------------------------------------------------------------------- account mapping

export type MappingState = "NO_DESTINATION" | "READY" | "REAUTH_REQUIRED" | "DISCONNECTED" | "UNAVAILABLE";

export const MAPPING_STATE_LABELS: Record<MappingState, string> = {
  NO_DESTINATION: "No publishing destination",
  READY: "Ready to publish",
  REAUTH_REQUIRED: "Reconnect required",
  DISCONNECTED: "Disconnected",
  UNAVAILABLE: "Unavailable",
};

/**
 * What a page's connection to its Publishing Destination looks like RIGHT NOW. Derived from the destination and the
 * provider rows on every read (the same checks the Publishing Center applies before it lets anything be scheduled), so a
 * disconnected, re-authorization-pending, removed or blocked account is shown as such - nothing here is stored, nothing
 * can drift, and no account is ever fabricated: with no destination linked, the state is NO_DESTINATION.
 */
export function buildMapping(page: PageRow, internal: boolean) {
  const s = page.socialAccount;
  const legacyProfiles = page.uploadPostProfiles.map((p) => ({
    id: p.id,
    username: internal ? p.username : null,
    status: p.status,
    blocked: p.blocked,
    accountCount: p._count.accounts,
    lastSyncedAt: p.lastSyncedAt,
  }));
  if (!s) {
    return {
      state: "NO_DESTINATION" as MappingState,
      stateLabel: MAPPING_STATE_LABELS.NO_DESTINATION,
      linked: false,
      issues: [] as ValidationIssue[],
      destination: null,
      upload: null,
      publishing: { canPublish: false, provider: null, platform: page.platform, capabilities: [] as string[] },
      lastSyncedAt: null as Date | null,
      usernameMatchesDestination: null as boolean | null,
      profileMappedToOtherPage: null as { id: string; name: string } | null,
      uploadPostProfiles: legacyProfiles,
    };
  }
  const up = s.uploadPostAccount;
  const facts = destinationFactsOf(s);
  const issues = validateDestination(facts, (page.platform ?? s.platform) as PlatformKey);
  const has = (code: string) => issues.some((i) => i.code === code);
  const state: MappingState =
    issues.length === 0
      ? "READY"
      : has("PROVIDER_REAUTH_REQUIRED")
        ? "REAUTH_REQUIRED"
        : has("ACCOUNT_NOT_CONNECTED") || has("PROVIDER_DISCONNECTED") || has("DESTINATION_NOT_LINKED")
          ? "DISCONNECTED"
          : "UNAVAILABLE";
  const mappedPage = up?.profile.managedPage ?? null;
  return {
    state,
    stateLabel: MAPPING_STATE_LABELS[state],
    linked: true,
    issues,
    destination: {
      id: s.id,
      platform: s.platform,
      handle: s.handle,
      displayName: s.displayName,
      status: s.status,
      provider: s.publishingProvider,
      lastErrorMessage: s.lastErrorMessage,
    },
    upload: up
      ? {
          accountId: up.id,
          accountStatus: up.status,
          platform: up.platform,
          reauthRequired: up.reauthRequired,
          lastSeenAt: up.lastSeenAt,
          profileStatus: up.profile.status,
          profileBlocked: up.profile.blocked,
          profile: internal ? { id: up.profile.id, username: up.profile.username } : null,
        }
      : null,
    publishing: {
      canPublish: state === "READY",
      provider: s.publishingProvider,
      platform: s.platform,
      capabilities: facts.uploadPost?.capabilities ?? [],
    },
    // when this destination was last confirmed by the provider synchronization (null = never / not an Upload-Post destination)
    lastSyncedAt: up ? (up.profile.lastSyncedAt ?? up.lastSeenAt) : s.lastSyncedAt,
    usernameMatchesDestination: page.username ? normalizeHandle(page.username) === normalizeHandle(s.handle) : null,
    // the Phase 2 mapping (Upload-Post profile -> page) points somewhere else: shown, never silently changed
    profileMappedToOtherPage: mappedPage && mappedPage.id !== page.id ? mappedPage : null,
    uploadPostProfiles: legacyProfiles,
  };
}

export type Mapping = ReturnType<typeof buildMapping>;

// ---------------------------------------------------------------------------------------------- page dto

export function missingFields(page: Pick<PageRow, "platform" | "username" | "categoryId">): string[] {
  const out: string[] = [];
  if (!page.platform) out.push("platform");
  if (!page.username) out.push("username");
  if (!page.categoryId) out.push("category");
  return out;
}

/** One row of a page list: the page record, its category and groups, and the state of its destination. */
export function toPageListItem(page: PageRow, actor: SafeUser) {
  const mapping = buildMapping(page, canSeeInternal(actor));
  const { identity } = resolveForPage(page);
  return {
    id: page.id,
    name: page.name,
    slug: page.slug,
    status: page.status,
    platform: page.platform,
    username: page.username,
    profileUrl: page.profileUrl,
    description: page.description,
    targetAudience: page.targetAudience,
    language: page.language,
    effectiveLanguage: identity.language,
    category: page.category ? { id: page.category.id, name: page.category.name, status: page.category.status } : null,
    groups: page.groupMemberships.filter((m) => m.group.status === "ACTIVE").map((m) => ({ id: m.group.id, name: m.group.name })),
    mapping: {
      state: mapping.state,
      stateLabel: mapping.stateLabel,
      destination: mapping.destination ? { id: mapping.destination.id, handle: mapping.destination.handle, provider: mapping.destination.provider, status: mapping.destination.status } : null,
    },
    incomplete: missingFields(page),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}
export type PageListItem = ReturnType<typeof toPageListItem>;
