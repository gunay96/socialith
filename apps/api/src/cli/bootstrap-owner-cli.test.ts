import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapOwnerMock = vi.hoisted(() => vi.fn());

vi.mock("../services/bootstrap-owner.service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/bootstrap-owner.service.js")>();
  return { ...original, bootstrapOwner: bootstrapOwnerMock };
});

import { BootstrapOwnerError } from "../services/bootstrap-owner.service.js";
import { EXIT, UsageError, parseArgs, runBootstrapOwnerCli } from "./bootstrap-owner-cli.js";

const PROD_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: "mysql://dbuser:DB-PASSWORD-SENTINEL@mysql:3306/db",
  SESSION_SECRET: "0123456789abcdef-test-session-secret",
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
  NEXT_PUBLIC_APP_URL: "https://app.mycompany.io",
  API_PUBLIC_URL: "https://app.mycompany.io",
};
const PASSWORD = "Tr0ub4dor&3-correct-horse";
const BASE_ARGS = [
  "--email", "ada@mycompany.io",
  "--name", "Ada Owner",
  "--organization", "My Company",
  "--confirm-domain", "app.mycompany.io",
  "--password-stdin",
];

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c: Buffer) => out.push(c.toString()));
  stderr.on("data", (c: Buffer) => err.push(c.toString()));
  return { stdout, stderr, text: () => out.join("") + err.join("") };
}

function deps(overrides: { env?: NodeJS.ProcessEnv; stdin?: Readable & { isTTY?: boolean } } = {}) {
  const cap = capture();
  return {
    cap,
    deps: {
      env: overrides.env ?? PROD_ENV,
      stdin: overrides.stdin ?? Readable.from([`${PASSWORD}\n`]),
      stdout: cap.stdout,
      stderr: cap.stderr,
      db: {} as never,
    },
  };
}

beforeEach(() => {
  bootstrapOwnerMock.mockReset();
  bootstrapOwnerMock.mockResolvedValue({ status: "created", organizationId: "org_1", userId: "user_1", email: "ada@mycompany.io" });
});

describe("parseArgs", () => {
  it("parses both `--flag value` and `--flag=value`", () => {
    const a = parseArgs(["--email=a@b.io", "--name", "Ada", "--password-stdin"]);
    expect(a).toMatchObject({ email: "a@b.io", name: "Ada", passwordStdin: true });
  });

  it.each([["--password"], ["--password=hunter2"], ["-p"], ["--pass", "x"]])(
    "refuses a command-line password (%s) with an explanation",
    (...argv) => {
      expect(() => parseArgs(argv)).toThrow(UsageError);
      expect(() => parseArgs(argv)).toThrow(/never accepted on the command line/);
    },
  );

  it("rejects unknown options, missing values and conflicting password sources", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--email"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--email", "--name"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--password-stdin", "--password-file", "x"])).toThrow(/only one/);
  });
});

describe("runBootstrapOwnerCli", () => {
  it("creates the owner on the happy path and passes the validated input (not argv) to the service", async () => {
    const { cap, deps: d } = deps();
    const code = await runBootstrapOwnerCli(BASE_ARGS, d);
    expect(code).toBe(EXIT.OK);
    expect(bootstrapOwnerMock).toHaveBeenCalledTimes(1);
    expect(bootstrapOwnerMock.mock.calls[0]![1]).toMatchObject({
      email: "ada@mycompany.io",
      organizationSlug: "my-company",
      password: PASSWORD,
    });
    expect(cap.text()).toContain("Owner created: ada@mycompany.io");
  });

  it("NEVER prints the password or the database password, on any path", async () => {
    const happy = deps();
    await runBootstrapOwnerCli(BASE_ARGS, happy.deps);
    bootstrapOwnerMock.mockRejectedValueOnce(Object.assign(new Error(`connect failed mysql://dbuser:DB-PASSWORD-SENTINEL@mysql`), { code: "P1001" }));
    const failing = deps();
    const code = await runBootstrapOwnerCli(BASE_ARGS, failing.deps);
    expect(code).toBe(EXIT.FAILURE);
    for (const text of [happy.cap.text(), failing.cap.text()]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain("DB-PASSWORD-SENTINEL");
    }
    expect(failing.cap.text()).toContain("P1001");
  });

  it("refuses outside production before reading the password or touching the database", async () => {
    const { cap, deps: d } = deps({ env: { ...PROD_ENV, NODE_ENV: "development" } });
    const code = await runBootstrapOwnerCli(BASE_ARGS, d);
    expect(code).toBe(EXIT.REFUSED);
    expect(bootstrapOwnerMock).not.toHaveBeenCalled();
    expect(cap.text()).toContain("NODE_ENV");
  });

  it("refuses without or with a wrong --confirm-domain", async () => {
    const noDomain = deps();
    expect(await runBootstrapOwnerCli(BASE_ARGS.filter((_, i) => i < 6 || i > 7), noDomain.deps)).toBe(EXIT.REFUSED);
    const wrong = deps();
    const argv = [...BASE_ARGS];
    argv[7] = "other.example.org";
    expect(await runBootstrapOwnerCli(argv, wrong.deps)).toBe(EXIT.REFUSED);
    expect(bootstrapOwnerMock).not.toHaveBeenCalled();
  });

  it("refuses a weak password and does not call the service", async () => {
    const { cap, deps: d } = deps({ stdin: Readable.from(["change-me-in-dev\n"]) });
    expect(await runBootstrapOwnerCli(BASE_ARGS, d)).toBe(EXIT.REFUSED);
    expect(bootstrapOwnerMock).not.toHaveBeenCalled();
    expect(cap.text()).not.toContain("change-me-in-dev\n");
  });

  it("refuses when no password source exists (no TTY and no --password-*)", async () => {
    const { cap, deps: d } = deps({ stdin: Object.assign(Readable.from([]), { isTTY: false }) });
    const argv = BASE_ARGS.slice(0, -1);
    expect(await runBootstrapOwnerCli(argv, d)).toBe(EXIT.REFUSED);
    expect(cap.text()).toContain("--password-stdin");
  });

  it("maps a database-state refusal to exit code 3 and prints its message", async () => {
    bootstrapOwnerMock.mockRejectedValueOnce(new BootstrapOwnerError("NOT_EMPTY", "already has user accounts"));
    const { cap, deps: d } = deps();
    expect(await runBootstrapOwnerCli(BASE_ARGS, d)).toBe(EXIT.STATE);
    expect(cap.text()).toContain("NOT_EMPTY");
  });

  it("reports an idempotent re-run as success without claiming the password changed", async () => {
    bootstrapOwnerMock.mockResolvedValueOnce({ status: "already-initialized", organizationId: "o", userId: "u", email: "ada@mycompany.io" });
    const { cap, deps: d } = deps();
    expect(await runBootstrapOwnerCli(BASE_ARGS, d)).toBe(EXIT.OK);
    expect(cap.text()).toMatch(/Nothing was changed.*NOT modified/);
  });

  it("requires --email, --name and --organization", async () => {
    const { deps: d } = deps();
    expect(await runBootstrapOwnerCli(["--confirm-domain", "app.mycompany.io", "--password-stdin"], d)).toBe(EXIT.REFUSED);
  });

  it("prints usage and exits 0 for --help without any other checks", async () => {
    const { cap, deps: d } = deps({ env: {} });
    expect(await runBootstrapOwnerCli(["--help"], d)).toBe(EXIT.OK);
    expect(cap.text()).toContain("Usage:");
  });
});
