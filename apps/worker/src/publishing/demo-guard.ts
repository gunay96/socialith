/**
 * Demo/seed accounts (packages/database/prisma/seed.ts) carry fake tokens
 * and exist only so the dashboard has something to show. They are tagged
 * `providerMetadata.seed === true` and must NEVER reach a real platform API
 * — regardless of whether their content is overdue, scheduled, or retried.
 * A real account's providerMetadata comes from its OAuth profile and never
 * contains this flag.
 */
export function isDemoAccount(providerMetadata: unknown): boolean {
  return (
    typeof providerMetadata === "object" &&
    providerMetadata !== null &&
    !Array.isArray(providerMetadata) &&
    (providerMetadata as Record<string, unknown>).seed === true
  );
}

export const DEMO_ACCOUNT_PUBLISH_MESSAGE =
  "This is a demo (seed) account with fake credentials; publishing is disabled for demo data.";
