import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Resolves @socialith/* to workspace source (as tsconfig.json declares), so unit tests never depend on a prior build.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: { environment: "node", globals: false },
});