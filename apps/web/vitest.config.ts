import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src/", import.meta.url));
const pkg = (name: string) => fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

// The same aliases tsconfig.json declares: "@/" is the app's own source, workspace packages resolve to their SOURCE so
// unit tests never depend on a prior build (CI runs unit tests before `pnpm build`).
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: src },
      { find: "@socialith/publishing", replacement: pkg("publishing") },
      { find: "@socialith/studio", replacement: pkg("studio") },
      { find: "@socialith/types", replacement: pkg("types") },
    ],
  },
  test: {
    environment: "node",
    globals: false,
  },
});