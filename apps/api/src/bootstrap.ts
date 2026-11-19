import { EnvValidationError, loadEnv } from "@socialith/config";
import { logger } from "./logger.js";

/**
 * Production entry point (`node dist/bootstrap.js`) — same purpose as
 * apps/worker/src/bootstrap.ts: validate configuration before the import
 * graph (lib/queue.ts calls loadEnv() at module scope) can crash with an
 * unstructured stack trace. One structured log naming every bad variable,
 * then a clean non-zero exit.
 */
try {
  loadEnv();
} catch (err) {
  if (err instanceof EnvValidationError) {
    logger.fatal({ issues: err.issues }, "Invalid environment configuration — API not started");
  } else {
    logger.fatal({ err }, "Failed to load configuration — API not started");
  }
  process.exit(1);
}

try {
  await import("./index.js");
} catch (err) {
  logger.fatal({ err }, "API failed during startup");
  process.exit(1);
}
