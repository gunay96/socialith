import { configDefaults, defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Phase 01 scope: apps/worker has no test files yet (see
// docs/architecture.md — it only ships a smoke-test queue/processor, no
// business logic that owns tests of its own so far). Vitest's default
// behavior is to exit 1 on "no test files found", which made `pnpm test`
// (and CI's Test step) fail for the whole monorepo even though every
// actual test elsewhere passes. `passWithNoTests` makes that an accepted,
// documented state instead of a false failure — it does not add or skip
// any test, and apps/api/apps/web/packages/auth's real suites are
// unaffected (each has its own vitest.config.ts).
//
// tsconfigPaths resolves @socialith/* to workspace SOURCE (the same aliases
// `pnpm typecheck` uses), exactly like apps/api/vitest.config.ts and this app's
// integration config. Without it Vite resolves each package through its
// package.json "main" (./dist/index.js), which only exists after a build: tests
// passed on a machine with stale dist/ output and failed on a clean checkout
// (CI runs unit tests before build). Unit tests must not depend on build output.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: false,
    passWithNoTests: true,
    // Real MySQL/Redis tests run only via vitest.integration.config.ts.
    exclude: [...configDefaults.exclude, "src/integration/**"],
  },
});
