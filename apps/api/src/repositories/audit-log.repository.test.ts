import { describe, expect, it, vi, beforeEach } from "vitest";

const createMock = vi.fn().mockResolvedValue({});

vi.mock("@socialith/database", () => ({
  prisma: {
    auditLog: {
      create: createMock,
    },
  },
}));

const { createAuditLog } = await import("./audit-log.repository.js");

beforeEach(() => {
  createMock.mockClear();
  createMock.mockResolvedValue({});
});

describe("createAuditLog", () => {
  it("writes the expected shape for a successful login", async () => {
    await createAuditLog({
      organizationId: "org_1",
      userId: "user_1",
      action: "LOGIN_SUCCESS",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org_1",
        userId: "user_1",
        action: "LOGIN_SUCCESS",
      }),
    });
  });

  it("strips forbidden keys (password, token, secret, hash, credential) from metadata", async () => {
    await createAuditLog({
      organizationId: "org_1",
      userId: "user_1",
      action: "LOGIN_FAILED",
      metadata: {
        reason: "invalid_password",
        password: "should-never-be-stored",
        passwordHash: "should-never-be-stored",
        sessionToken: "should-never-be-stored",
        apiSecret: "should-never-be-stored",
        credential: "should-never-be-stored",
      },
    });

    const [[{ data }]] = createMock.mock.calls;
    expect(data.metadataJson).toEqual({ reason: "invalid_password" });
  });

  it("omits metadataJson entirely when every key was forbidden", async () => {
    await createAuditLog({
      organizationId: "org_1",
      action: "LOGIN_FAILED",
      metadata: { token: "x" },
    });

    const [[{ data }]] = createMock.mock.calls;
    expect(data.metadataJson).toBeUndefined();
  });

  it("never throws when the database write fails", async () => {
    createMock.mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      createAuditLog({ organizationId: "org_1", action: "LOGIN_SUCCESS" }),
    ).resolves.toBeUndefined();
  });
});
