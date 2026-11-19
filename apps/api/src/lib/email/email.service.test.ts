import { describe, expect, it, vi } from "vitest";
import { ConsoleEmailService, getEmailService } from "./email.service.js";

describe("ConsoleEmailService", () => {
  it("sendInvitation logs via the injected logger only, with the expected fields", async () => {
    const infoMock = vi.fn();
    const service = new ConsoleEmailService({ info: infoMock });

    await service.sendInvitation({
      to: "invitee@example.com",
      organizationName: "Acme",
      role: "EDITOR",
      invitedByName: "Ada",
      acceptUrl: "https://app.socialith.co/accept-invitation/raw-token-value",
    });

    expect(infoMock).toHaveBeenCalledTimes(1);
    const [fields, message] = infoMock.mock.calls[0];
    expect(fields.to).toBe("invitee@example.com");
    expect(fields.acceptUrl).toContain("raw-token-value");
    expect(message).toMatch(/no real email provider is connected/i);
  });

  it("sendPasswordReset logs via the injected logger only, with the expected fields", async () => {
    const infoMock = vi.fn();
    const service = new ConsoleEmailService({ info: infoMock });
    const expiresAt = new Date("2026-01-01T00:00:00.000Z");

    await service.sendPasswordReset({
      to: "user@example.com",
      resetUrl: "https://app.socialith.co/reset-password/raw-reset-token",
      expiresAt,
    });

    expect(infoMock).toHaveBeenCalledTimes(1);
    const [fields, message] = infoMock.mock.calls[0];
    expect(fields.to).toBe("user@example.com");
    expect(fields.resetUrl).toContain("raw-reset-token");
    expect(fields.expiresAt).toBe(expiresAt.toISOString());
    expect(message).toMatch(/no real email provider is connected/i);
  });
});

describe("getEmailService", () => {
  it("returns a ConsoleEmailService for provider 'console' (the only supported value today)", () => {
    const service = getEmailService({ info: vi.fn() }, "console");
    expect(service).toBeInstanceOf(ConsoleEmailService);
  });

  it("throws for an unsupported provider value on a fresh module instance", async () => {
    // getEmailService caches a module-level singleton on first call, so
    // this needs its own fresh module state (vi.resetModules + a fresh
    // dynamic import) rather than reusing the import at the top of this
    // file — otherwise the cached "console" instance from the test
    // above would be returned regardless of what provider is passed
    // here, and this would silently test nothing.
    vi.resetModules();
    const fresh = await import("./email.service.js");
    expect(() => fresh.getEmailService({ info: vi.fn() }, "sendgrid" as "console")).toThrow(
      /Unsupported EMAIL_PROVIDER/,
    );
  });
});
