import type { Role } from "@socialith/auth";
import type { UserStatus } from "@socialith/database";

/**
 * What the API is allowed to return about a user, and what
 * requireAuth attaches to `req.user`. Deliberately excludes
 * `passwordHash`, `sessionVersion`, and `organizationId`'s siblings we
 * don't need — this is the type-level enforcement of "/api/auth/me must
 * never return password hashes, sessionVersion, tokens, or secrets."
 */
export interface SafeUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
}
