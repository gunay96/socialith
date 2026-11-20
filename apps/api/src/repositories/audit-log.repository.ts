import { prisma } from "@socialith/database";
import type { Prisma } from "@socialith/database";
import { logger } from "../logger.js";

/**
 * Extendable as more actions are audited in later phases — kept to
 * exactly what's actually logged so the type catches a typo'd action
 * string. `action` itself is a plain string column (not a DB enum), so
 * adding a value here is a type-only change, never a migration.
 */
export type AuditAction =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "INVITATION_CREATED"
  | "INVITATION_ACCEPTED"
  | "USER_ROLE_CHANGED"
  | "USER_DISABLED"
  | "USER_ENABLED"
  | "USER_REMOVED"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET_COMPLETED"
  // Phase 04 — only the real, currently-implemented action. CONNECTED /
  // TOKEN_REFRESHED / STATUS_CHANGED land in the phase that implements
  // the real OAuth flow those describe, not before.
  | "SOCIAL_ACCOUNT_DISCONNECTED"
  | "SOCIAL_ACCOUNT_CONNECTED"
  // Written by the one-time production owner bootstrap CLI (TD-32).
  | "OWNER_BOOTSTRAPPED"
  // Phase 2: Upload-Post provider integration (mappings, destinations, music).
  | "UPLOAD_POST_SYNC_REQUESTED"
  | "UPLOAD_POST_MAPPING_CHANGED"
  | "UPLOAD_POST_DESTINATION_ENABLED"
  | "UPLOAD_POST_DESTINATION_DISABLED"
  | "MANAGED_PAGE_CREATED"
  | "MANAGED_PAGE_UPDATED"
  | "CREATOR_CREATED"
  | "CREATOR_UPDATED"
  | "MUSIC_MAPPING_CREATED"
  | "MUSIC_MAPPING_VERIFIED"
  | "MUSIC_MAPPING_RIGHTS_CHANGED"
  | "MUSIC_MAPPING_DELETED"
  // Phase 3: Publishing Center (approvals and scheduling are also kept per publication in publication_events).
  | "PUBLISHING_SETTINGS_CHANGED"
  | "PUBLICATION_CREATED"
  | "PUBLICATION_SUBMITTED"
  | "PUBLICATION_APPROVED"
  | "PUBLICATION_SELF_APPROVED"
  | "PUBLICATION_APPROVAL_DENIED"
  | "PUBLICATION_REJECTED"
  | "PUBLICATION_SCHEDULED"
  | "PUBLICATION_RESCHEDULED"
  | "PUBLICATION_CANCELLED"
  // Phase 4: Page Network. Page create/edit reuse MANAGED_PAGE_CREATED / MANAGED_PAGE_UPDATED (Phase 2) with the changed fields.
  | "PAGE_CATEGORY_CREATED"
  | "PAGE_CATEGORY_UPDATED"
  | "PAGE_CATEGORY_ARCHIVED"
  | "PAGE_CATEGORY_RESTORED"
  | "PAGE_CATEGORY_STARTERS_ADDED"
  | "MANAGED_PAGE_ARCHIVED"
  | "MANAGED_PAGE_RESTORED"
  | "MANAGED_PAGE_IDENTITY_UPDATED"
  | "MANAGED_PAGE_DESTINATION_LINKED"
  | "MANAGED_PAGE_DESTINATION_UNLINKED"
  | "PAGE_GROUP_CREATED"
  | "PAGE_GROUP_UPDATED"
  | "PAGE_GROUP_ARCHIVED"
  | "PAGE_GROUP_RESTORED"
  | "PAGE_GROUP_MEMBERS_ADDED"
  | "PAGE_GROUP_MEMBER_REMOVED"
  | "CAMPAIGN_PAGES_ASSIGNED"
  | "CAMPAIGN_PAGE_UNASSIGNED"
  | "CAMPAIGN_PAGE_GROUPS_ASSIGNED"
  | "CAMPAIGN_PAGE_GROUP_UNASSIGNED"
  // Phase 5: media library, text library, recipes, renders, AI studio.
  | "MEDIA_PACK_UPLOADED"
  | "MEDIA_PACK_UPDATED"
  | "MEDIA_PACK_ARCHIVED"
  | "MEDIA_PACK_RESTORED"
  | "MEDIA_ASSET_UPLOADED"
  | "MEDIA_ASSET_UPDATED"
  | "MEDIA_ASSET_ARCHIVED"
  | "MEDIA_ASSET_RESTORED"
  | "MEDIA_ASSET_REANALYZE_REQUESTED"
  | "MEDIA_RIGHTS_CHANGED"
  | "MEDIA_ASSIGNMENT_CHANGED";

interface CreateAuditLogInput {
  organizationId: string;
  userId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

// Defense in depth: even though callers should never pass these, strip
// any key that looks like it could hold a secret before it's ever
// serialized into metadata_json. Matches "password", "passwordHash",
// "token", "secret", "hash" (case-insensitively) anywhere in the key.
const FORBIDDEN_METADATA_KEY_PATTERN = /password|token|secret|hash|credential/i;

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const safeEntries = Object.entries(metadata).filter(([key]) => {
    const isForbidden = FORBIDDEN_METADATA_KEY_PATTERN.test(key);
    if (isForbidden) {
      logger.warn({ key }, "Dropped forbidden key from audit log metadata");
    }
    return !isForbidden;
  });
  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : undefined;
}

/**
 * Writes one AuditLog row. Never throws — a failed audit write must not
 * fail (or roll back) the auth action it's describing; it's logged via
 * pino instead so the failure is still visible operationally.
 */
export async function createAuditLog(input: CreateAuditLogInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        metadataJson: sanitizeMetadata(input.metadata) as unknown as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    logger.error({ err, action: input.action }, "Failed to write audit log");
  }
}
