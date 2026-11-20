import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// OPT-IN, READ-ONLY live verification against the real Upload-Post service (see
// src/integration/upload-post-live.live.test.ts). Never part of CI or of `pnpm test` /
// `pnpm test:integration`. Needs UPLOAD_POST_LIVE_TEST=1, UPLOAD_POST_API_KEY and a throwaway MySQL
// (MYSQL_INTEGRATION_URL) — the test writes only to its own throwaway organization there.
const mysqlUrl = process.env.MYSQL_INTEGRATION_URL;
if (!mysqlUrl) {
  throw new Error("MYSQL_INTEGRATION_URL is required (a throwaway test database, see docs/DATABASE_MYSQL.md).");
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: false,
    include: ["src/integration/**/*.live.test.ts"],
    globalSetup: ["../../scripts/vitest-mysql-migrate-setup.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: "test", DATABASE_URL: mysqlUrl, LOG_LEVEL: "silent" },
  },
});
