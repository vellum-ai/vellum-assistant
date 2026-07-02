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
      // Require braces on every control-statement body (if/else/for/
      // while/do). A braceless body is a maintenance hazard: a second
      // line added under the condition reads as guarded but always runs.
      curly: ["warn", "all"],
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
  // `cli/no-daemon-internals` enforces the CLI ↔ daemon import boundary
  // that the CLI → IPC refactor is built on. Keep at `"error"`: a soft
  // rule here would let daemon-internal imports re-enter the CLI bundle,
  // which is the regression class this rule exists to prevent.
  {
    files: ["src/cli/commands/**/*.ts"],
    ignores: ["src/cli/commands/**/__tests__/**"],
    plugins: {
      cli: { rules: { "no-daemon-internals": cliNoDaemonInternals } },
    },
    rules: { "cli/no-daemon-internals": "error" },
  },
]);

export default eslintConfig;
