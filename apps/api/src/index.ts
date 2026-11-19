import Redis from "ioredis";
import { loadEnv } from "@socialith/config";
import { prisma } from "@socialith/database";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import { closeQueues } from "./lib/queue.js";

const env = loadEnv();

// Optional — the shared-hosting/demo-lite tier (cPanel Setup Node.js App,
// no persistent worker) boots without Redis. See @socialith/config's
// REDIS_URL and createApp's own doc for what falls back to what.
const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    })
  : null;

if (!redis) {
  logger.warn(
    "REDIS_URL not configured — booting without Redis. Sessions/rate-limits use in-memory fallbacks; content generation, video rendering, scheduled publishing, and analytics sync are disabled (see lib/queue.ts). Login, OAuth connect, Dashboard, and Accounts are unaffected.",
  );
}

redis?.on("error", (err) => {
  logger.error({ err }, "Redis connection error");
});

const app = createApp(redis);

const server = app.listen(env.API_PORT, () => {
  logger.info(`Socialith API listening on port ${env.API_PORT}`);
});

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  server.close(async () => {
    await Promise.allSettled([prisma.$disconnect(), redis?.quit(), closeQueues()]);
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
