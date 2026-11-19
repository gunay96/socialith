import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Reuses tsconfig.json's compilerOptions.paths (the same sibling-source
// aliases tsc/tsx already resolve for `pnpm typecheck`/`pnpm dev` — see
// docs/architecture.md "Production package resolution") so Vitest can
// resolve @socialith/* imports too, without requiring those packages'
// dist/ to be built first. Vite/Vitest never read tsconfig "paths" on
// their own — this plugin is what bridges that gap. No effect on the
// production build: `tsc -p tsconfig.build.json` (apps/api's real build)
// doesn't use this file or this plugin at all.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: false,
  },
});
