import { defineConfig, globalIgnores } from "eslint/config";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

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
            // Node.js builtins
            ["^node:"],
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

      // Standardize on `undefined` only — avoid `null` in new code.
      // Prefer `=== undefined`, `?? fallback`, or `?.` optional chaining
      // instead of `=== null`.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "BinaryExpression[operator='==='][right.type='Literal'][right.raw='null']",
          message:
            "Avoid `=== null`. Prefer `=== undefined`, `?? fallback`, or optional chaining `?.` instead.",
        },
        {
          selector:
            "BinaryExpression[operator='==='][left.type='Literal'][left.raw='null']",
          message:
            "Avoid `null ===`. Prefer `=== undefined`, `?? fallback`, or optional chaining `?.` instead.",
        },
        {
          selector:
            "BinaryExpression[operator='!=='][right.type='Literal'][right.raw='null']",
          message:
            "Avoid `!== null`. Prefer `!== undefined`, nullish coalescing `??`, or optional chaining `?.` instead.",
        },
        {
          selector:
            "BinaryExpression[operator='!=='][left.type='Literal'][left.raw='null']",
          message:
            "Avoid `null !==`. Prefer `!== undefined`, nullish coalescing `??`, or optional chaining `?.` instead.",
        },
      ],
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
