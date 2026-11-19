/**
 * The Upload-Post API key is deployment-wide (one environment variable), but all provider data is
 * organization-scoped. This decides which organization the key belongs to:
 *  - UPLOAD_POST_ORGANIZATION_ID, when set (must be an existing organization);
 *  - otherwise the deployment's ONLY organization;
 *  - otherwise (several organizations, no explicit id) the integration is ambiguous and refuses to guess.
 * Pure on purpose: callers pass in the ids so api, worker and tests share the exact same rule.
 */
export type IntegrationOrganization =
  | { ok: true; organizationId: string }
  | { ok: false; reason: "NO_ORGANIZATION" | "AMBIGUOUS" | "CONFIGURED_ORGANIZATION_NOT_FOUND" };

export function resolveIntegrationOrganization(existingOrganizationIds: readonly string[], configuredId?: string): IntegrationOrganization {
  if (configuredId) {
    return existingOrganizationIds.includes(configuredId)
      ? { ok: true, organizationId: configuredId }
      : { ok: false, reason: "CONFIGURED_ORGANIZATION_NOT_FOUND" };
  }
  if (existingOrganizationIds.length === 0) return { ok: false, reason: "NO_ORGANIZATION" };
  if (existingOrganizationIds.length > 1) return { ok: false, reason: "AMBIGUOUS" };
  return { ok: true, organizationId: existingOrganizationIds[0]! };
}

export const INTEGRATION_ORGANIZATION_MESSAGES: Record<Exclude<IntegrationOrganization, { ok: true }>["reason"], string> = {
  NO_ORGANIZATION: "No organization exists yet.",
  AMBIGUOUS: "This deployment has several organizations; set UPLOAD_POST_ORGANIZATION_ID to say which one owns the Upload-Post key.",
  CONFIGURED_ORGANIZATION_NOT_FOUND: "UPLOAD_POST_ORGANIZATION_ID does not match any organization.",
};
