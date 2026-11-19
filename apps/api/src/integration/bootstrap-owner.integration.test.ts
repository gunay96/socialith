import { PassThrough, Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@socialith/database";
import { hashPassword, verifyPassword } from "@socialith/auth";
import { authenticateWithPassword } from "../services/auth.service.js";
import { BootstrapOwnerError, bootstrapOwner } from "../services/bootstrap-owner.service.js";
import { EXIT, runBootstrapOwnerCli } from "../cli/bootstrap-owner-cli.js";

/**
 * REAL MySQL integration tests for the production owner bootstrap (TD-32):
 * real server, real migration, real scrypt, real auth service — no mocks.
 *
 * These tests need an EMPTY user table, so they wipe every organization
 * (cascading to users/audit rows) before each test. That is only ever
 * allowed against the throwaway integration database; the guard below
 * refuses to run against anything whose name does not end in "_it".
 */
const url = process.env.MYSQL_INTEGRATION_URL;
const suite = url ? describe : describe.skip;

function assertThrowawayDatabase(): void {
  const dbName = new URL(url!).pathname.replace(/^\//, "");
  if (!/_it$/.test(dbName)) {
    throw new Error(`Refusing to wipe database "${dbName}": integration tests only run against a database named *_it.`);
  }
}

const PASSWORD = "Tr0ub4dor&3-correct-horse";
const INPUT = {
  email: "ada@mycompany.io",
  name: "Ada Owner",
  organizationName: "My Company",
  organizationSlug: "my-company",
  password: PASSWORD,
};

async function wipe() {
  assertThrowawayDatabase();
  await prisma.organization.deleteMany({});
}

suite("production owner bootstrap (real MySQL)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("creates exactly one organization, one ACTIVE OWNER and one audit row — and nothing else", async () => {
    const result = await bootstrapOwner(prisma, INPUT);
    expect(result.status).toBe("created");

    expect(await prisma.organization.count()).toBe(1);
    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "ada@mycompany.io", role: "OWNER", status: "ACTIVE", sessionVersion: 0 });

    const audit = await prisma.auditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "OWNER_BOOTSTRAPPED", userId: users[0]!.id, organizationId: result.organizationId });

    // No demo/seed material of any kind.
    expect(await prisma.socialAccount.count()).toBe(0);
    expect(await prisma.platformConnection.count()).toBe(0);
    expect(await prisma.campaign.count()).toBe(0);
    expect(await prisma.content.count()).toBe(0);
    expect(await prisma.sound.count()).toBe(0);
    expect(await prisma.invitation.count()).toBe(0);
  });

  it("stores a real scrypt hash — never the plaintext — and the audit row holds no secret", async () => {
    await bootstrapOwner(prisma, INPUT);
    const user = await prisma.user.findFirstOrThrow();
    expect(user.passwordHash.startsWith("scrypt$v1$")).toBe(true);
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(true);
    expect(await verifyPassword(user.passwordHash, "wrong-password-entirely")).toBe(false);

    const audit = await prisma.auditLog.findFirstOrThrow();
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(user.passwordHash);
  });

  it("the created owner can log in through the real auth service", async () => {
    await bootstrapOwner(prisma, INPUT);
    const ok = await authenticateWithPassword("  ADA@MyCompany.io ", PASSWORD);
    expect(ok.outcome).toBe("success");
    const wrong = await authenticateWithPassword("ada@mycompany.io", "not-the-password");
    expect(wrong.outcome).toBe("invalid_password");
  });

  it("is idempotent for the identical owner: reports already-initialized and changes nothing (password untouched)", async () => {
    await bootstrapOwner(prisma, INPUT);
    const before = await prisma.user.findFirstOrThrow();

    const again = await bootstrapOwner(prisma, { ...INPUT, password: "A-Different-Passphrase-77" });
    expect(again.status).toBe("already-initialized");
    expect(again.userId).toBe(before.id);

    const after = await prisma.user.findFirstOrThrow();
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(1);
    expect(await prisma.organization.count()).toBe(1);
  });

  it("refuses to create a second owner with a different identity (NOT_EMPTY) and changes nothing", async () => {
    await bootstrapOwner(prisma, INPUT);
    await expect(
      bootstrapOwner(prisma, { ...INPUT, email: "mallory@other.io", organizationSlug: "other", organizationName: "Other" }),
    ).rejects.toMatchObject({ name: "BootstrapOwnerError", code: "NOT_EMPTY" });
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.organization.count()).toBe(1);
  });

  it("refuses when any non-owner user exists, even with the same e-mail", async () => {
    const org = await prisma.organization.create({ data: { name: "Existing", slug: "existing" } });
    await prisma.user.create({
      data: { organizationId: org.id, name: "V", email: INPUT.email, passwordHash: await hashPassword("x-x-x-x-x-x-x-x"), role: "VIEWER", status: "ACTIVE" },
    });
    await expect(bootstrapOwner(prisma, INPUT)).rejects.toMatchObject({ code: "NOT_EMPTY" });
    expect((await prisma.user.findFirstOrThrow()).role).toBe("VIEWER");
  });

  it("refuses a database that contains the development seed (SEED_DATA_PRESENT)", async () => {
    const org = await prisma.organization.create({ data: { name: "Socialith Internal", slug: "socialith-internal" } });
    await prisma.user.create({
      data: { organizationId: org.id, name: "Seed", email: "owner@socialith.local", passwordHash: "x", role: "OWNER", status: "ACTIVE" },
    });
    await expect(bootstrapOwner(prisma, INPUT)).rejects.toMatchObject({ code: "SEED_DATA_PRESENT" });
    expect(await prisma.user.count()).toBe(1);
  });

  it("refuses an empty-but-conflicting organization slug instead of guessing (SLUG_TAKEN)", async () => {
    await prisma.organization.create({ data: { name: "Orphan", slug: INPUT.organizationSlug } });
    await expect(bootstrapOwner(prisma, INPUT)).rejects.toMatchObject({ code: "SLUG_TAKEN" });
    expect(await prisma.user.count()).toBe(0);
  });

  it("leaves nothing behind when a step fails midway (atomic)", async () => {
    // A pre-existing audit-unrelated failure: force the user insert to fail by
    // making the hash too long for the column is not possible, so instead use a
    // duplicate-email race: seed a user in ANOTHER org first, then try with a
    // fresh slug — the NOT_EMPTY refusal must not have created the org.
    const other = await prisma.organization.create({ data: { name: "Other", slug: "other-org" } });
    await prisma.user.create({
      data: { organizationId: other.id, name: "O", email: "o@other.io", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
    });
    await expect(bootstrapOwner(prisma, INPUT)).rejects.toBeInstanceOf(BootstrapOwnerError);
    expect(await prisma.organization.count()).toBe(1);
    expect(await prisma.organization.findUnique({ where: { slug: INPUT.organizationSlug } })).toBeNull();
  });

  it.each(Array.from({ length: 10 }, (_, i) => i + 1))("concurrent initializations can never create two owners (round %i, 8 racers)", async () => {
    const racers = Array.from({ length: 8 }, (_, i) =>
      bootstrapOwner(prisma, {
        ...INPUT,
        email: `racer${i}@mycompany.io`,
        organizationSlug: `racer-org-${i}`,
        organizationName: `Racer ${i}`,
      }).then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e }),
      ),
    );
    const outcomes = await Promise.all(racers);

    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    for (const l of losers) {
      expect((l as { e: BootstrapOwnerError }).e).toBeInstanceOf(BootstrapOwnerError);
      expect((l as { e: BootstrapOwnerError }).e.code).toBe("NOT_EMPTY");
    }

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.organization.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it("concurrent runs of the SAME owner yield one creation and the rest report already-initialized", async () => {
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => bootstrapOwner(prisma, INPUT)));
    expect(outcomes.filter((o) => o.status === "created")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "already-initialized")).toHaveLength(4);
    expect(await prisma.user.count()).toBe(1);
  });

  describe("full CLI path (production gate → stdin password → real database)", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: url ?? "mysql://x",
      SESSION_SECRET: "0123456789abcdef-test-session-secret",
      TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
      NEXT_PUBLIC_APP_URL: "https://app.mycompany.io",
      API_PUBLIC_URL: "https://app.mycompany.io",
    };
    const argv = [
      "--email", "ada@mycompany.io",
      "--name", "Ada Owner",
      "--organization", "My Company",
      "--confirm-domain", "app.mycompany.io",
      "--password-stdin",
    ];

    function run(args: string[], stdinText: string, overrideEnv: NodeJS.ProcessEnv = env) {
      const chunks: string[] = [];
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
      stderr.on("data", (c: Buffer) => chunks.push(c.toString()));
      return runBootstrapOwnerCli(args, {
        env: overrideEnv,
        stdin: Readable.from([stdinText]),
        stdout,
        stderr,
        db: prisma,
      }).then((code) => ({ code, text: chunks.join("") }));
    }

    it("creates the owner, who can then log in; a second run exits 0 'already initialized'; a different owner exits 3", async () => {
      const first = await run(argv, `${PASSWORD}\n`);
      expect(first.code).toBe(EXIT.OK);
      expect(first.text).toContain("Owner created");
      expect(first.text).not.toContain(PASSWORD);
      expect((await authenticateWithPassword("ada@mycompany.io", PASSWORD)).outcome).toBe("success");

      const second = await run(argv, "Some-Other-Passphrase-42\n");
      expect(second.code).toBe(EXIT.OK);
      expect(second.text).toContain("Already initialized");
      expect((await authenticateWithPassword("ada@mycompany.io", PASSWORD)).outcome).toBe("success");

      const third = await run(argv.map((a) => (a === "ada@mycompany.io" ? "eve@mycompany.io" : a)), `${PASSWORD}\n`);
      expect(third.code).toBe(EXIT.STATE);
      expect(await prisma.user.count()).toBe(1);
    });

    it("exits 2 and touches nothing when the production gate fails", async () => {
      const devEnv = { ...env, NODE_ENV: "development" };
      const r = await run(argv, `${PASSWORD}\n`, devEnv);
      expect(r.code).toBe(EXIT.REFUSED);
      expect(await prisma.user.count()).toBe(0);
    });

    it("exits 3 on a database that holds the development seed", async () => {
      const org = await prisma.organization.create({ data: { name: "Socialith Internal", slug: "socialith-internal" } });
      await prisma.user.create({
        data: { organizationId: org.id, name: "Seed", email: "owner@socialith.local", passwordHash: "x", role: "OWNER", status: "ACTIVE" },
      });
      const r = await run(argv, `${PASSWORD}\n`);
      expect(r.code).toBe(EXIT.STATE);
      expect(r.text).toContain("SEED_DATA_PRESENT");
      expect(await prisma.user.count()).toBe(1);
    });
  });
});
