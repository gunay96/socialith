import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Real-infrastructure integration tests for the worker (MySQL + Redis).
// Separate from the default config so `pnpm test` needs no infrastructure.
// Run: `pnpm --filter @socialith/worker test:integration` with
// MYSQL_INTEGRATION_URL and REDIS_INTEGRATION_URL set — see docs/DATABASE_MYSQL.md.
//
// tsconfigPaths resolves @socialith/* to workspace SOURCE (like apps/api's
// config) so the tests never depend on stale package dist/ output.
//
// Env below is test-only scaffolding for loadEnv() — throwaway, not secrets.
const mysqlUrl = process.env.MYSQL_INTEGRATION_URL;
const redisUrl = process.env.REDIS_INTEGRATION_URL;
if (!mysqlUrl || !redisUrl) {
  throw new Error(
    "MYSQL_INTEGRATION_URL and REDIS_INTEGRATION_URL are required, e.g. mysql://socialith:<pw>@127.0.0.1:3384/socialith_it and redis://127.0.0.1:6390 (see docs/DATABASE_MYSQL.md).",
  );
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: false,
    include: ["src/integration/**/*.integration.test.ts"],
    globalSetup: ["../../scripts/vitest-mysql-migrate-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: mysqlUrl,
      REDIS_URL: redisUrl,
      SESSION_SECRET: "integration-test-session-secret-0123456789",
      TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
      LOG_LEVEL: "silent",
    },
  },
});
