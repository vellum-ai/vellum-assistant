import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

import { noCrossDomainImports } from "./eslint-rules/no-cross-domain-imports.mjs";

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores(["dist/**", "src/generated/**"]),
  {
    plugins: {
      local: { rules: { "no-cross-domain-imports": noCrossDomainImports } },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "local/no-cross-domain-imports": "error",
    },
  },
]);

export default eslintConfig;
