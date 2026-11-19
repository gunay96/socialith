import { prisma } from "@socialith/database";

export async function findOrganizationName(organizationId: string): Promise<string> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  // organizationId always comes from the authenticated session (see
  // requireAuth), which re-reads the user fresh from the database on
  // every request — so a missing organization here would mean the
  // user's own org was deleted out from under them mid-request, not a
  // client-supplied bad ID. Falling back rather than throwing keeps the
  // invitation email/response usable either way.
  return organization?.name ?? "your organization";
}
