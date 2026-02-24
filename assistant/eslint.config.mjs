import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores(["dist/**", "drizzle/**"]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Standardize on `undefined` only — avoid `null` in new code.
      // Prefer `=== undefined`, `?? fallback`, or `?.` optional chaining
      // instead of `=== null`. Existing code is grandfathered in (warn, not
      // error) so we don't need a mass refactor.
      "no-restricted-syntax": [
        "warn",
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
]);

export default eslintConfig;
