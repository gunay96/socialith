// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/prisma/migrations/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Flat config declares no globals by default (unlike the old
    // `env: "commonjs"` shortcut), so plain CommonJS config files like
    // apps/web/postcss.config.js fail `no-undef` on `module`/`require` —
    // the only files in this repo still written as CJS.
    files: ["**/*.config.js"],
    languageOptions: {
      globals: { module: "writable", require: "readonly" },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
);
