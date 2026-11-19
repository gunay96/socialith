import { defineConfig } from "vitest/config";

// Phase 01 scope: apps/worker has no test files yet (see
// docs/architecture.md — it only ships a smoke-test queue/processor, no
// business logic that owns tests of its own so far). Vitest's default
// behavior is to exit 1 on "no test files found", which made `pnpm test`
// (and CI's Test step) fail for the whole monorepo even though every
// actual test elsewhere passes. `passWithNoTests` makes that an accepted,
// documented state instead of a false failure — it does not add or skip
// any test, and apps/api/apps/web/packages/auth's real suites are
// unaffected (each has its own vitest.config.ts).
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    passWithNoTests: true,
  },
});
