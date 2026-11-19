import { Router } from "express";
import { prisma } from "@socialith/database";
import type { Redis } from "ioredis";
import type { ApiResponse, HealthStatus } from "@socialith/types";
import { getQueueHealth } from "../lib/queue.js";
import { logger } from "../logger.js";

/**
 * `redis` is optional — the shared-hosting/demo-lite tier boots without
 * one (see @socialith/config's REDIS_URL, apps/api/src/index.ts). `checks.redis`
 * then reports `false` honestly rather than skipping the field, since
 * `false` here means "not configured", not "configured but down" — the
 * `queues` block below (also omitted without Redis) is where that
 * real, known limitation (no async job processing) is visible.
 */
export function healthRouter(redis: Redis | null): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const checks: HealthStatus["checks"] = {
      api: true,
      database: false,
      redis: false,
    };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
    }

    try {
      const pong = redis ? await redis.ping() : null;
      checks.redis = pong === "PONG";
    } catch {
      checks.redis = false;
    }

    // Redis absent-by-design (shared-hosting/demo-lite tier, no REDIS_URL)
    // must not read as "degraded" forever on an otherwise-healthy
    // deployment — only count it against `status` when it was actually
    // configured and failed to respond.
    const requiredChecks = redis ? checks : { api: checks.api, database: checks.database };
    const allHealthy = Object.values(requiredChecks).every(Boolean);
    const anyHealthy = Object.values(requiredChecks).some(Boolean);
    const status: HealthStatus["status"] = allHealthy ? "ok" : anyHealthy ? "degraded" : "down";

    const queues = checks.redis
      ? await getQueueHealth().catch((err) => {
          logger.warn({ err }, "health: queue backlog query failed");
          return undefined;
        })
      : undefined;

    const body: ApiResponse<HealthStatus> = {
      success: true,
      data: {
        status,
        checks,
        queues,
        timestamp: new Date().toISOString(),
      },
    };

    res.status(allHealthy ? 200 : 503).json(body);
  });

  return router;
}
