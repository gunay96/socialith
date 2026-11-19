import { hashPassword, verifyPassword, generateSecureToken } from "@socialith/auth";
import type { User } from "@socialith/database";
import { findUserByEmail } from "../repositories/user.repository.js";
import type { SafeUser } from "../types/auth.js";

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    organizationId: user.organizationId,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

// A real scrypt hash of a random, never-reused value — computed once
// per process and reused. Verifying against this when the email doesn't
// match any user means we always pay the same scrypt cost whether the
// email exists or not, so the login endpoint's response time doesn't leak
// which emails are registered. Recomputed (not hardcoded) so no fixed
// hash ships in source.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(generateSecureToken());
  }
  return dummyHashPromise;
}

export type AuthenticateResult =
  | { outcome: "success"; user: User }
  | { outcome: "unknown_email" }
  | { outcome: "invalid_password"; user: User }
  | { outcome: "disabled"; user: User };

/**
 * Verifies an email/password pair. Always resolves — never throws for a
 * bad credential, only for genuine infrastructure failures (DB down,
 * etc.), which the caller should let propagate to the error handler.
 *
 * Deliberately returns *why* it failed (unknown_email / invalid_password
 * / disabled) so the caller can audit-log the real reason internally,
 * while still presenting one generic "invalid email or password" message
 * to the client regardless of which case it was — the spec's "do not
 * reveal whether the email exists" requirement, extended to also not
 * reveal a disabled account's existence.
 */
export async function authenticateWithPassword(
  email: string,
  password: string,
): Promise<AuthenticateResult> {
  // Emails are expected to be stored lowercased (see seed.ts and the
  // future invitation-acceptance flow) — normalize the lookup to match.
  const normalizedEmail = email.trim().toLowerCase();
  const user = await findUserByEmail(normalizedEmail);

  // Run the (slow, memory-hard) scrypt verify unconditionally, against
  // either the real hash or the dummy one, so this function takes
  // roughly the same time whether or not the user exists.
  const hashToVerify = user?.passwordHash ?? (await getDummyHash());
  const passwordIsValid = await verifyPassword(hashToVerify, password);

  if (!user) {
    return { outcome: "unknown_email" };
  }
  if (!passwordIsValid) {
    return { outcome: "invalid_password", user };
  }
  if (user.status !== "ACTIVE") {
    return { outcome: "disabled", user };
  }
  return { outcome: "success", user };
}
