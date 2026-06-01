import { defineConfig, globalIgnores } from "eslint/config";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

import cliNoDaemonInternals from "./eslint-rules/cli-no-daemon-internals.js";
import typedMockModule from "./eslint-rules/typed-mock-module.js";

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
  // `mock/typed-module` nudges toward `satisfies Partial<typeof import("…")>`
  // on mock.module() factory returns so tsc catches signature drift. Off by
  // default — enable as "warn" when ready to start migrating existing mocks.
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    plugins: { mock: { rules: { "typed-module": typedMockModule } } },
    rules: { "mock/typed-module": "off" },
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
