import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { healthRouter } from "./health.js";

vi.mock("@socialith/database", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  },
}));

// lib/queue.ts opens a real Redis connection (via @socialith/config's
// loadEnv()) at module load time — mocked here so this test file never
// needs real env vars or a real Redis connection, same reasoning as the
// @socialith/database mock above.
vi.mock("../lib/queue.js", () => ({
  getQueueHealth: vi.fn().mockResolvedValue([]),
}));

describe("GET /health", () => {
  it("reports ok when database and redis are reachable", async () => {
    const app = express();
    const fakeRedis = { ping: vi.fn().mockResolvedValue("PONG") } as never;
    app.use(healthRouter(fakeRedis));

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("ok");
    expect(res.body.data.checks).toEqual({ api: true, database: true, redis: true });
  });

  it("reports degraded when redis is unreachable", async () => {
    const app = express();
    const fakeRedis = {
      ping: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as never;
    app.use(healthRouter(fakeRedis));

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.data.checks.redis).toBe(false);
    expect(res.body.data.status).toBe("degraded");
  });

  it("reports ok (not degraded) when redis is not configured at all", async () => {
    const app = express();
    app.use(healthRouter(null));

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.data.checks).toEqual({ api: true, database: true, redis: false });
    expect(res.body.data.status).toBe("ok");
    expect(res.body.data.queues).toBeUndefined();
  });
});
