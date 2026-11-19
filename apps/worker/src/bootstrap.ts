import { EnvValidationError, loadEnv } from "@socialith/config";
import { logger } from "./logger.js";

/**
 * Production entry point (`node dist/bootstrap.js`). Validates the
 * environment BEFORE anything else is imported: index.ts's import graph
 * calls loadEnv() at module scope (publishing/enqueue.ts,
 * scheduled/producers.ts), so a bad configuration used to surface as an
 * unstructured stack trace thrown from an import. Here it becomes one
 * structured log line naming every offending variable, then a clean exit —
 * exactly what an operator (or `docker logs`) needs to see.
 */
try {
  loadEnv();
} catch (err) {
  if (err instanceof EnvValidationError) {
    logger.fatal({ issues: err.issues }, "Invalid environment configuration — worker not started");
  } else {
    logger.fatal({ err }, "Failed to load configuration — worker not started");
  }
  process.exit(1);
}

try {
  await import("./index.js");
} catch (err) {
  logger.fatal({ err }, "Worker failed during startup");
  process.exit(1);
}
