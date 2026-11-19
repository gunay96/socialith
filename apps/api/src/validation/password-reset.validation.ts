import { z } from "zod";
import { passwordPolicySchema } from "./password-policy.js";

export const forgotPasswordSchema = z.object({
  email: z.string().trim().min(1, "Email is required").max(320).email("Invalid email address"),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/**
 * The token is a 256-bit value base64url-encoded by
 * @socialith/auth's generateSecureToken — comfortably under 512 chars.
 * Loose bounds are intentional: an invalid/garbage token still reaches
 * the service (which hashes and looks it up, finds nothing, and
 * returns the same generic error) rather than being rejected here with
 * a differently-shaped response that could hint at *why* it failed.
 */
export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1, "Reset token is required").max(512),
  password: passwordPolicySchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
