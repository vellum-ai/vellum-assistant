import { defineConfig, globalIgnores } from "eslint/config";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

import cliNoDaemonInternals from "./eslint-rules/cli-no-daemon-internals.js";

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores(["dist/**", "drizzle/**"]),
  {
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "simple-import-sort/imports": [
        "error",
        {
          groups: [
            // Runtime builtins (Node.js and Bun)
            ["^node:", "^bun:"],
            // External packages
            ["^@?\\w"],
            // Internal/relative imports
            ["^\\."],
          ],
        },
      ],
      "simple-import-sort/exports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/config/*-schema.ts", "src/config/schema.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/cli/commands/**/*.ts"],
    ignores: ["src/cli/commands/**/__tests__/**"],
    plugins: { cli: { rules: { "no-daemon-internals": cliNoDaemonInternals } } },
    rules: { "cli/no-daemon-internals": "error" },
  },
]);

export default eslintConfig;
