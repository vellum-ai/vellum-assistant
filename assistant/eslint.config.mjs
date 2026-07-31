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
      curly: ["error", "all"],
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
  // Managed-column profile resolution (`getEffectiveProfile(s)`) resolves
  // default profiles against the vellum column only, ignoring
  // `llm.defaultProvider`; on a BYO install that is not the body that
  // dispatches. Runtime code must use `resolveDefaultProfileForProvider` /
  // `getEffectiveProfilesForProvider` instead. The allowlist below is the
  // full set of intentional managed-column consumers: the catalog itself,
  // hatch-time seeding (writes managed stubs by design), and write-path
  // validation.
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/config/default-profile-catalog.ts",
      "src/config/seed-inference-profiles.ts",
      "src/config/inference-profile-validation.ts",
      "**/__tests__/**",
      "**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/default-profile-catalog.js"],
              importNames: ["getEffectiveProfile", "getEffectiveProfiles"],
              message:
                "Managed-column resolution ignores llm.defaultProvider. Use resolveDefaultProfileForProvider / getEffectiveProfilesForProvider with the parsed config's llm.defaultProvider ?? null.",
            },
          ],
        },
      ],
    },
  },
  // `cli/no-daemon-internals` keeps daemon-internal modules out of the CLI's
  // static import graph, so `assistant …` invocations (including the bash-tool
  // fast path) don't pay the memory cost of loading daemon subsystems. Keep at
  // `"error"`: a soft rule would let hoisted daemon imports creep back in.
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
