import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Vitest globalSetup for the MySQL integration suite. Lives outside `src/`
 * on purpose so the production build never emits it into dist/.
 *
 * Applies the real, committed migrations (`prisma migrate deploy` — exactly
 * what production runs) to the target database before any test executes.
 * The Prisma CLI is invoked directly through node, so this works without
 * pnpm/npx being on PATH. Idempotent: a second run is a no-op.
 */
export default function setup(): void {
  const url = process.env.MYSQL_INTEGRATION_URL;
  if (!url) throw new Error("MYSQL_INTEGRATION_URL is required.");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const databasePackage = path.resolve(here, "../../packages/database");
  const requireFromDatabase = createRequire(path.join(databasePackage, "package.json"));
  const prismaCli = path.join(path.dirname(requireFromDatabase.resolve("prisma/package.json")), "build", "index.js");

  const result = spawnSync(
    process.execPath,
    [prismaCli, "migrate", "deploy", "--schema", path.join(databasePackage, "prisma", "schema.prisma")],
    { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}
