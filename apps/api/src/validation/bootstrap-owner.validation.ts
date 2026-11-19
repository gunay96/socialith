import { z } from "zod";
import { passwordPolicySchema } from "./password-policy.js";

/**
 * Validation for the one-time production owner bootstrap (TD-32).
 * Stricter than the team-invite schemas on purpose: this is the account
 * that can do everything, so obviously-fake identities are refused rather
 * than silently accepted.
 */

/** Hosts/TLDs that can never be a real mailbox for a production owner. */
const RESERVED_EMAIL_SUFFIXES = [".local", ".localhost", ".test", ".invalid", ".example"];
const RESERVED_EMAIL_DOMAINS = ["example.com", "example.org", "example.net"];

/**
 * The development seed password is public (it is in packages/database/
 * prisma/seed.ts). A production owner must never use it, or any value
 * derived trivially from the account identity.
 */
const KNOWN_WEAK_PASSWORDS = ["change-me-in-dev", "changeme1234", "password1234", "123456789012", "socialith1234"];

const slugSchema = z
  .string()
  .min(2, "Organization slug must be at least 2 characters")
  .max(60, "Organization slug must be at most 60 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Organization slug may only contain lowercase letters, digits and single hyphens");

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Email is required")
  .max(320)
  .email("Invalid email address")
  .refine((email) => {
    const domain = email.split("@")[1] ?? "";
    const reservedDomain = RESERVED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
    return !reservedDomain && !RESERVED_EMAIL_SUFFIXES.some((s) => domain.endsWith(s));
  }, "Email must be a real, deliverable address (reserved/local/example domains are refused)");

export const bootstrapOwnerInputSchema = z
  .object({
    email: emailSchema,
    name: z.string().trim().min(1, "Name is required").max(200),
    organizationName: z.string().trim().min(1, "Organization name is required").max(200),
    organizationSlug: slugSchema.optional(),
    password: passwordPolicySchema,
  })
  .superRefine((value, ctx) => {
    const lowered = value.password.toLowerCase();
    if (KNOWN_WEAK_PASSWORDS.includes(lowered)) {
      ctx.addIssue({ code: "custom", path: ["password"], message: "Password is on the list of known weak/development passwords" });
    }
    const localPart = value.email.split("@")[0] ?? "";
    if (localPart.length >= 4 && lowered.includes(localPart)) {
      ctx.addIssue({ code: "custom", path: ["password"], message: "Password must not contain the email's local part" });
    }
    if (/^(.)\1+$/.test(value.password)) {
      ctx.addIssue({ code: "custom", path: ["password"], message: "Password must not be one repeated character" });
    }
  });

export type BootstrapOwnerInput = z.input<typeof bootstrapOwnerInputSchema>;

export interface ValidatedOwnerInput {
  email: string;
  name: string;
  organizationName: string;
  organizationSlug: string;
  password: string;
}

/** Returns the normalized input or the list of human-readable problems (never echoing the password). */
export function validateOwnerInput(
  input: BootstrapOwnerInput,
): { ok: true; value: ValidatedOwnerInput } | { ok: false; problems: string[] } {
  const parsed = bootstrapOwnerInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`) };
  }
  const slug = parsed.data.organizationSlug ?? slugify(parsed.data.organizationName);
  const slugCheck = slugSchema.safeParse(slug);
  if (!slugCheck.success) {
    return {
      ok: false,
      problems: [`organizationSlug: could not derive a valid slug from the organization name; pass --slug explicitly`],
    };
  }
  return { ok: true, value: { ...parsed.data, organizationSlug: slug } };
}
