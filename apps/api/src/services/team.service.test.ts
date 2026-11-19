import { describe, expect, it, vi, beforeEach } from "vitest";

const { repoMocks, auditLogCreateMock } = vi.hoisted(() => {
  const auditLogCreateMock = vi.fn().mockResolvedValue(undefined);
  const repoMocks = {
    listOrganizationMembers: vi.fn(),
    findOrganizationMemberById: vi.fn(),
    updateMemberRole: vi.fn(),
    updateMemberStatus: vi.fn(),
    countOtherActiveOwners: vi.fn(),
    listPendingInvitations: vi.fn(),
  };
  return { repoMocks, auditLogCreateMock };
});

vi.mock("../repositories/team.repository.js", () => ({
  listOrganizationMembers: repoMocks.listOrganizationMembers,
  findOrganizationMemberById: repoMocks.findOrganizationMemberById,
  updateMemberRole: repoMocks.updateMemberRole,
  updateMemberStatus: repoMocks.updateMemberStatus,
  countOtherActiveOwners: repoMocks.countOtherActiveOwners,
}));

vi.mock("../repositories/invitation.repository.js", () => ({
  listPendingInvitations: repoMocks.listPendingInvitations,
}));

vi.mock("../repositories/audit-log.repository.js", () => ({
  createAuditLog: auditLogCreateMock,
}));

const {
  getTeam,
  changeMemberRole,
  disableMember,
  enableMember,
  removeMember,
} = await import("./team.service.js");

function actor(role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER", overrides: Record<string, unknown> = {}) {
  return {
    id: "actor_1",
    organizationId: "org_1",
    name: "Actor",
    email: "actor@example.com",
    role,
    status: "ACTIVE" as const,
    lastLoginAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function targetUser(role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER", overrides: Record<string, unknown> = {}) {
  return {
    id: "target_1",
    organizationId: "org_1",
    name: "Target",
    email: "target@example.com",
    passwordHash: "irrelevant",
    role,
    status: "ACTIVE",
    lastLoginAt: null,
    sessionVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getTeam", () => {
  it("returns members and pending invitations together", async () => {
    repoMocks.listOrganizationMembers.mockResolvedValue([{ id: "u1" }]);
    repoMocks.listPendingInvitations.mockResolvedValue([{ id: "inv1" }]);

    const result = await getTeam("org_1");

    expect(result).toEqual({ members: [{ id: "u1" }], pendingInvitations: [{ id: "inv1" }] });
    expect(repoMocks.listOrganizationMembers).toHaveBeenCalledWith("org_1");
  });
});

describe("changeMemberRole", () => {
  it("rejects an OWNER changing their own role (400), before even loading the target", async () => {
    await expect(changeMemberRole(actor("OWNER", { id: "same_id" }), "same_id", "ADMIN")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(repoMocks.findOrganizationMemberById).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND (404) for a target outside the actor's organization", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(null);

    await expect(changeMemberRole(actor("OWNER"), "someone_elses_id", "ADMIN")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("blocks an ADMIN from modifying an OWNER (403), before the last-owner check even runs", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("OWNER"));

    await expect(changeMemberRole(actor("ADMIN"), "target_1", "EDITOR")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(repoMocks.updateMemberRole).not.toHaveBeenCalled();
    expect(repoMocks.countOtherActiveOwners).not.toHaveBeenCalled();
  });

  it("blocks an ADMIN from promoting anyone to OWNER (403)", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("EDITOR"));

    await expect(changeMemberRole(actor("ADMIN"), "target_1", "OWNER")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(repoMocks.updateMemberRole).not.toHaveBeenCalled();
  });

  it("rejects demoting the last remaining active OWNER (409), even for another OWNER acting", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("OWNER", { status: "ACTIVE" }));
    repoMocks.countOtherActiveOwners.mockResolvedValue(0);

    await expect(
      changeMemberRole(actor("OWNER", { id: "another_owner" }), "target_1", "ADMIN"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repoMocks.updateMemberRole).not.toHaveBeenCalled();
    expect(repoMocks.countOtherActiveOwners).toHaveBeenCalledWith("org_1", "target_1");
  });

  it("allows an OWNER to change another OWNER's role when another active OWNER remains", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("OWNER", { status: "ACTIVE" }));
    repoMocks.countOtherActiveOwners.mockResolvedValue(1);
    repoMocks.updateMemberRole.mockResolvedValue(targetUser("ADMIN"));

    const result = await changeMemberRole(actor("OWNER", { id: "another_owner" }), "target_1", "ADMIN");
    expect(result.role).toBe("ADMIN");
  });

  it("does not run the last-owner check for a DISABLED owner (they aren't a functioning owner today)", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("OWNER", { status: "DISABLED" }));
    repoMocks.updateMemberRole.mockResolvedValue(targetUser("ADMIN", { status: "DISABLED" }));

    const result = await changeMemberRole(actor("OWNER", { id: "another_owner" }), "target_1", "ADMIN");
    expect(result.role).toBe("ADMIN");
    expect(repoMocks.countOtherActiveOwners).not.toHaveBeenCalled();
  });

  it("lets an OWNER promote a member to OWNER, and writes USER_ROLE_CHANGED", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("EDITOR"));
    repoMocks.updateMemberRole.mockResolvedValue(targetUser("OWNER"));

    const result = await changeMemberRole(actor("OWNER", { id: "another_owner" }), "target_1", "OWNER");

    expect(result.role).toBe("OWNER");
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "USER_ROLE_CHANGED",
        targetId: "target_1",
        metadata: { previousRole: "EDITOR", newRole: "OWNER" },
      }),
    );
  });

  it("lets an ADMIN change an EDITOR to VIEWER", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("EDITOR"));
    repoMocks.updateMemberRole.mockResolvedValue(targetUser("VIEWER"));

    const result = await changeMemberRole(actor("ADMIN"), "target_1", "VIEWER");
    expect(result.role).toBe("VIEWER");
  });
});

describe("disableMember", () => {
  it("rejects disabling yourself (400) before even looking up the target", async () => {
    await expect(disableMember(actor("OWNER", { id: "same_id" }), "same_id")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(repoMocks.findOrganizationMemberById).not.toHaveBeenCalled();
  });

  it("blocks an ADMIN from disabling an OWNER (403)", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("OWNER"));
    await expect(disableMember(actor("ADMIN"), "target_1")).rejects.toMatchObject({ statusCode: 403 });
    expect(repoMocks.updateMemberStatus).not.toHaveBeenCalled();
  });

  it("disables an EDITOR as ADMIN and logs USER_DISABLED", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("EDITOR"));
    repoMocks.updateMemberStatus.mockResolvedValue(targetUser("EDITOR", { status: "DISABLED" }));

    const result = await disableMember(actor("ADMIN"), "target_1");

    expect(result.status).toBe("DISABLED");
    expect(repoMocks.updateMemberStatus).toHaveBeenCalledWith("target_1", "DISABLED");
    expect(auditLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({ action: "USER_DISABLED" }));
  });
});

describe("enableMember", () => {
  it("blocks an ADMIN from enabling/toggling an OWNER (403)", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("OWNER", { status: "DISABLED" }));
    await expect(enableMember(actor("ADMIN"), "target_1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("re-enables a disabled EDITOR and logs USER_ENABLED", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("EDITOR", { status: "DISABLED" }));
    repoMocks.updateMemberStatus.mockResolvedValue(targetUser("EDITOR", { status: "ACTIVE" }));

    const result = await enableMember(actor("OWNER"), "target_1");

    expect(result.status).toBe("ACTIVE");
    expect(auditLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({ action: "USER_ENABLED" }));
  });
});

describe("removeMember", () => {
  it("rejects removing yourself (400)", async () => {
    await expect(removeMember(actor("ADMIN", { id: "same_id" }), "same_id")).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("blocks an ADMIN from removing an OWNER (403)", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("OWNER"));
    await expect(removeMember(actor("ADMIN"), "target_1")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("soft-removes (status: REMOVED, not a hard delete) and logs USER_REMOVED", async () => {
    repoMocks.findOrganizationMemberById.mockResolvedValue(targetUser("VIEWER"));
    repoMocks.updateMemberStatus.mockResolvedValue(targetUser("VIEWER", { status: "REMOVED" }));

    const result = await removeMember(actor("OWNER"), "target_1");

    expect(result.status).toBe("REMOVED");
    expect(repoMocks.updateMemberStatus).toHaveBeenCalledWith("target_1", "REMOVED");
    expect(auditLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({ action: "USER_REMOVED" }));
  });
});
