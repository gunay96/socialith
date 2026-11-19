import type { PrismaClient } from "@socialith/database";
import type { Readable } from "node:stream";
import { BootstrapOwnerError, bootstrapOwner } from "../services/bootstrap-owner.service.js";
import { validateOwnerInput } from "../validation/bootstrap-owner.validation.js";
import { promptPasswordTwice, readPasswordFromFile, readPasswordFromStream } from "./password-input.js";
import { ProductionGateError, assertProductionEnvironment } from "./production-gate.js";

/**
 * `bootstrap-owner` command logic (entry point: ./bootstrap-owner.ts).
 * Everything here takes its dependencies as parameters so it is testable
 * without a real terminal, process or database.
 *
 * Exit codes:  0 created / already initialized (nothing changed)
 *              1 unexpected failure
 *              2 refused: bad usage, failed production gate, invalid input
 *              3 refused: database state forbids it (not empty, seed data, lock, schema)
 */
export const EXIT = { OK: 0, FAILURE: 1, REFUSED: 2, STATE: 3 } as const;

export const USAGE = `Usage:
  node apps/api/dist/cli/bootstrap-owner.js \\
      --email <address> --name <full name> --organization <name> \\
      --confirm-domain <app hostname> [--slug <org-slug>] \\
      [--password-file <path> | --password-stdin]

Creates the first (OWNER) account of a PRODUCTION deployment. Run it once.

  --email            owner's real e-mail address (reserved/example domains are refused)
  --name             owner's display name
  --organization     organization name
  --slug             organization slug (default: derived from the name)
  --confirm-domain   the hostname of NEXT_PUBLIC_APP_URL, to confirm the target
  --password-stdin   read the password from standard input
  --password-file    read the password from a file
  (neither)          prompt twice, hidden, on the terminal

The password is never accepted as a command-line argument or environment variable.
Requires NODE_ENV=production and a fully valid configuration. Refuses if any user already exists.`;

export interface CliArgs {
  email?: string;
  name?: string;
  organization?: string;
  slug?: string;
  confirmDomain?: string;
  passwordStdin: boolean;
  passwordFile?: string;
  help: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const VALUE_OPTIONS: Record<string, keyof CliArgs> = {
  "--email": "email",
  "--name": "name",
  "--organization": "organization",
  "--slug": "slug",
  "--confirm-domain": "confirmDomain",
  "--password-file": "passwordFile",
};

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { passwordStdin: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    const eq = raw.indexOf("=");
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);

    if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else if (flag === "--password-stdin") {
      args.passwordStdin = true;
    } else if (flag === "--password" || flag === "--pass" || flag === "-p") {
      throw new UsageError(
        "Passwords are never accepted on the command line (they would land in shell history and process listings). Use the hidden prompt, --password-stdin or --password-file.",
      );
    } else if (flag in VALUE_OPTIONS) {
      const key = VALUE_OPTIONS[flag]!;
      const value = inline ?? argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new UsageError(`${flag} requires a value.`);
      }
      (args as unknown as Record<string, unknown>)[key] = value;
    } else {
      throw new UsageError(`Unknown option: ${flag}`);
    }
  }
  if (args.passwordStdin && args.passwordFile) {
    throw new UsageError("Use only one of --password-stdin and --password-file.");
  }
  return args;
}

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  stdin: Readable & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  db: PrismaClient;
}

export async function runBootstrapOwnerCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const out = (line: string) => deps.stdout.write(`${line}\n`);
  const err = (line: string) => deps.stderr.write(`${line}\n`);

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`Error: ${(e as Error).message}`);
    err("");
    err(USAGE);
    return EXIT.REFUSED;
  }
  if (args.help) {
    out(USAGE);
    return EXIT.OK;
  }

  // 1. Environment gate — before any password is read or the DB is touched.
  try {
    assertProductionEnvironment(deps.env, args.confirmDomain);
  } catch (e) {
    if (e instanceof ProductionGateError) {
      err(`Error: ${e.message}`);
      for (const problem of e.problems) err(`  - ${problem}`);
      return EXIT.REFUSED;
    }
    throw e;
  }

  if (!args.email || !args.name || !args.organization) {
    err("Error: --email, --name and --organization are required.");
    err("");
    err(USAGE);
    return EXIT.REFUSED;
  }

  // 2. Password intake (never argv/env).
  let password: string;
  try {
    if (args.passwordFile) {
      const result = readPasswordFromFile(args.passwordFile);
      if (result.permissionWarning) err(`Warning: ${result.permissionWarning}`);
      password = result.password;
    } else if (args.passwordStdin) {
      password = await readPasswordFromStream(deps.stdin);
    } else if (deps.stdin.isTTY) {
      password = await promptPasswordTwice(deps.stdin, deps.stderr);
    } else {
      err("Error: no terminal available for the password prompt. Use --password-stdin or --password-file.");
      return EXIT.REFUSED;
    }
  } catch (e) {
    err(`Error: could not read the password (${(e as Error).message}).`);
    return EXIT.REFUSED;
  }

  // 3. Input validation (password policy included; the value is never echoed).
  const validated = validateOwnerInput({
    email: args.email,
    name: args.name,
    organizationName: args.organization,
    organizationSlug: args.slug,
    password,
  });
  if (!validated.ok) {
    err("Error: invalid input:");
    for (const problem of validated.problems) err(`  - ${problem}`);
    return EXIT.REFUSED;
  }

  // 4. The one write.
  try {
    const result = await bootstrapOwner(deps.db, validated.value);
    if (result.status === "already-initialized") {
      out(`Already initialized: ${result.email} is the existing OWNER. Nothing was changed (the password was NOT modified).`);
    } else {
      out(`Owner created: ${result.email}`);
      out(`  organization id: ${result.organizationId}`);
      out(`  user id:         ${result.userId}`);
      out("Next: sign in, then delete any password file you used. This command will now refuse to run again.");
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof BootstrapOwnerError) {
      err(`Refused (${e.code}): ${e.message}`);
      return EXIT.STATE;
    }
    // Deliberately terse: connection errors can carry host/credential
    // details; the operator can inspect `docker compose logs` for more.
    const code = (e as { code?: string } | null)?.code;
    err(`Unexpected failure (${(e as Error).name}${code ? `/${code}` : ""}). Check database connectivity and that migrations were applied. Nothing was committed.`);
    return EXIT.FAILURE;
  }
}
