import { describe, expect, it, vi } from "vitest";
import { BootstrapOwnerError, bootstrapOwner } from "./bootstrap-owner.service.js";

const INPUT = {
  email: "ada@mycompany.io",
  name: "Ada",
  organizationName: "My Company",
  organizationSlug: "my-company",
  password: "Tr0ub4dor&3-correct-horse",
};

describe("bootstrapOwner (error mapping; real behaviour is covered by the MySQL integration suite)", () => {
  it("hashes the password BEFORE opening the transaction and passes only the hash onward", async () => {
    const order: string[] = [];
    const hash = vi.fn(async (pw: string) => {
      order.push("hash");
      return `hashed:${pw.length}`;
    });
    const db = {
      $transaction: vi.fn(async () => {
        order.push("tx");
        return { status: "created", organizationId: "o", userId: "u", email: INPUT.email };
      }),
    };
    await bootstrapOwner(db as never, INPUT, { hash });
    expect(order).toEqual(["hash", "tx"]);
  });

  it("maps a missing-table Prisma error to SCHEMA_NOT_READY", async () => {
    const db = { $transaction: vi.fn().mockRejectedValue(Object.assign(new Error("no table"), { code: "P2021" })) };
    await expect(bootstrapOwner(db as never, INPUT, { hash: async () => "h" })).rejects.toMatchObject({
      name: "BootstrapOwnerError",
      code: "SCHEMA_NOT_READY",
    });
  });

  it("rethrows unexpected errors untouched", async () => {
    const boom = Object.assign(new Error("connection lost"), { code: "P1001" });
    const db = { $transaction: vi.fn().mockRejectedValue(boom) };
    await expect(bootstrapOwner(db as never, INPUT, { hash: async () => "h" })).rejects.toBe(boom);
  });

  it("passes BootstrapOwnerError through unchanged", async () => {
    const refusal = new BootstrapOwnerError("NOT_EMPTY", "x");
    const db = { $transaction: vi.fn().mockRejectedValue(refusal) };
    await expect(bootstrapOwner(db as never, INPUT, { hash: async () => "h" })).rejects.toBe(refusal);
  });
});
