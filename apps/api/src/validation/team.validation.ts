import { z } from "zod";
import { passwordPolicySchema } from "./password-policy.js";

/**
 * Roles assignable *through an invitation*. OWNER is deliberately
 * excluded here — spec: "OWNER cannot be assigned through invitation" —
 * regardless of who's sending the invite. This is enforced at the
 * schema level (not just in service logic) so a malformed/tampered
 * request body can never reach the service with role: "OWNER".
 */
export const invitableRoleSchema = z.enum(["ADMIN", "EDITOR", "VIEWER"]);

export const createInvitationSchema = z.object({
  email: z.string().trim().min(1, "Email is required").max(320).email("Invalid email address"),
  role: invitableRoleSchema,
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

/**
 * All four roles are valid targets for a role *change* (as opposed to
 * an invitation) — an existing OWNER can still be relabeled, and
 * ownership can still be transferred to an existing member — but
 * canAssignRole (@socialith/auth) still gates who is allowed to set
 * OWNER: only an existing OWNER.
 */
export const changeRoleSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER"]),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

/**
 * Password policy lives in password-policy.ts, not here — this is the
 * one place besides password reset that a password is actually *set*.
 */
export const acceptInvitationSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  password: passwordPolicySchema,
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
