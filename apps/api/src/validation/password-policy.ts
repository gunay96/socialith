import { z } from "zod";

/**
 * The password policy for every place a password is actually *set*
 * (invitation acceptance, password reset) — never at login, which
 * validates against an existing hash and is deliberately permissive on
 * shape (see auth.validation.ts). 12 characters is a deliberately
 * simple, defensible minimum for an internal tool; not a full
 * complexity/entropy policy. Kept in one place so invitation acceptance
 * and password reset can't silently drift apart.
 */
export const passwordPolicySchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(1024);
