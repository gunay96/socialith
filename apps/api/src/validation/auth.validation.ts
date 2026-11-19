import { z } from "zod";

/**
 * Deliberately permissive on password shape (min length 1) — we are
 * validating a login attempt against an *existing* hash, not enforcing a
 * password policy here. Password strength rules belong to whatever
 * creates the password (invitation acceptance, reset), not login.
 */
export const loginSchema = z.object({
  email: z.string().trim().min(1, "Email is required").max(320).email("Invalid email address"),
  password: z.string().min(1, "Password is required").max(1024),
});

export type LoginInput = z.infer<typeof loginSchema>;
