import { describe, expect, it } from "vitest";
import { slugify, validateOwnerInput } from "./bootstrap-owner.validation.js";

const GOOD = {
  email: "Owner@Company.io",
  name: "Ada Owner",
  organizationName: "Acme Records",
  password: "a-long-unrelated-passphrase-91",
};

describe("validateOwnerInput", () => {
  it("normalizes the email, derives the slug and keeps the password untouched", () => {
    const r = validateOwnerInput(GOOD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.email).toBe("owner@company.io");
      expect(r.value.organizationSlug).toBe("acme-records");
      expect(r.value.password).toBe(GOOD.password);
    }
  });

  it("honours an explicit valid slug and rejects an invalid one", () => {
    const ok = validateOwnerInput({ ...GOOD, organizationSlug: "acme" });
    expect(ok.ok && ok.value.organizationSlug).toBe("acme");
    expect(validateOwnerInput({ ...GOOD, organizationSlug: "Bad Slug!" }).ok).toBe(false);
    expect(validateOwnerInput({ ...GOOD, organizationSlug: "-x-" }).ok).toBe(false);
  });

  it.each([
    "owner@socialith.local",
    "a@b.test",
    "a@host.localhost",
    "a@example.com",
    "a@sub.example.org",
    "not-an-email",
  ])("refuses the non-deliverable address %s", (email) => {
    expect(validateOwnerInput({ ...GOOD, email }).ok).toBe(false);
  });

  it("enforces the shared password policy (12+ characters)", () => {
    const r = validateOwnerInput({ ...GOOD, password: "short-pw" });
    expect(r.ok).toBe(false);
  });

  it("refuses the public development seed password and weak patterns", () => {
    expect(validateOwnerInput({ ...GOOD, password: "change-me-in-dev" }).ok).toBe(false);
    expect(validateOwnerInput({ ...GOOD, password: "CHANGE-ME-IN-DEV" }).ok).toBe(false);
    expect(validateOwnerInput({ ...GOOD, password: "aaaaaaaaaaaaaaaa" }).ok).toBe(false);
  });

  it("refuses a password containing the email's local part", () => {
    expect(validateOwnerInput({ ...GOOD, email: "adaowner@company.io", password: "my-adaowner-secret-1" }).ok).toBe(false);
  });

  it("never echoes the password in the reported problems", () => {
    const secret = "short-pw!";
    const r = validateOwnerInput({ ...GOOD, password: secret });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).not.toContain(secret);
  });

  it("reports every missing field", () => {
    const r = validateOwnerInput({ email: "", name: "", organizationName: "", password: "" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe("slugify", () => {
  it("handles Turkish letters, punctuation and edge hyphens", () => {
    expect(slugify("  Müzik Yapım & Co.  ")).toBe("muzik-yapim-co");
    expect(slugify("ISPARTA ıı")).toBe("isparta-ii");
    expect(slugify("---")).toBe("");
  });
});
