import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...nextCoreWebVitals,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  globalIgnores(["node_modules/**", ".next/**", "next-env.d.ts"]),
  {
    settings: {
      // An explicit version skips eslint-plugin-react's autodetection, which
      // calls a context API that ESLint 10 removed.
      react: { version: "19.2" },
    },
    rules: {
      // Braces on every control-statement body; see root AGENTS.md.
      curly: ["error", "all"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
