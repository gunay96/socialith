import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Real-database integration tests (MySQL). Deliberately a separate config so
// `pnpm test` (unit tests, no infrastructure) never needs a database.
// Run via `pnpm --filter @socialith/api test:mysql` with MYSQL_INTEGRATION_URL
// pointing at an EMPTY MySQL database — see docs/DATABASE_MYSQL.md.
//
// Env below is test-only scaffolding for @socialith/config's loadEnv()
// (not secrets): throwaway values, used only inside this test process.
const url = process.env.MYSQL_INTEGRATION_URL;
if (!url) {
  throw new Error(
    "MYSQL_INTEGRATION_URL is required, e.g. mysql://socialith:<password>@127.0.0.1:3380/socialith_it (see docs/DATABASE_MYSQL.md).",
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
      DATABASE_URL: url,
      SESSION_SECRET: "integration-test-session-secret-0123456789",
      LOG_LEVEL: "silent",
      TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
      // Upload-Post tests talk to the in-repo contract double (fixed loopback port), never to the live service.
      UPLOAD_POST_API_KEY: "test-key-0000000000",
      UPLOAD_POST_BASE_URL: "http://127.0.0.1:39870/api",
      UPLOAD_POST_WEBHOOK_SECRET: "whsec_integration_secret_value_1",
      UPLOAD_POST_WEBHOOK_SECRET_PREVIOUS: "whsec_integration_previous_value_2",
      ...(process.env.REDIS_INTEGRATION_URL ? { REDIS_URL: process.env.REDIS_INTEGRATION_URL } : {}),
    },
  },
});
