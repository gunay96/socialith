import { prisma } from "@socialith/database";
import { runBootstrapOwnerCli } from "./bootstrap-owner-cli.js";

/**
 * Process entry point: `node apps/api/dist/cli/bootstrap-owner.js ...`
 * (inside the api image — see docs/VPS_DEPLOYMENT.md §"First owner").
 * All logic lives in bootstrap-owner-cli.ts so it can be tested.
 */
let exitCode = 1;
try {
  exitCode = await runBootstrapOwnerCli(process.argv.slice(2), {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    db: prisma,
  });
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
process.exit(exitCode);
