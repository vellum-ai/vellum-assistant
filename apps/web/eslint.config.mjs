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
      // Flag `dark:` paired with a raw color-scale utility. The `dark:`
      // custom-variant in packages/design-library/src/tokens.css only
      // matches [data-theme=dark] — NOT [data-theme=velvet] — so paired
      // utilities like `dark:bg-moss-700` silently break velvet contrast.
      // Use semantic tokens (--surface-*, --content-*, --border-*) instead.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/\\bdark:(bg|text|border|divide|ring|fill|stroke|outline|decoration|placeholder|accent|caret)-(moss|stone|forest|emerald|amber|danger)-\\d+/]",
          message:
            "Use a semantic token (e.g. bg-[var(--surface-lift)], text-[var(--content-default)]) instead of dark: paired with a color-scale utility. Semantic tokens are defined in packages/design-library/src/tokens.css and switch per data-theme automatically, including velvet. See apps/web/docs/STYLE_GUIDE.md.",
        },
        {
          selector:
            "TemplateElement[value.raw=/\\bdark:(bg|text|border|divide|ring|fill|stroke|outline|decoration|placeholder|accent|caret)-(moss|stone|forest|emerald|amber|danger)-\\d+/]",
          message:
            "Use a semantic token (e.g. bg-[var(--surface-lift)], text-[var(--content-default)]) instead of dark: paired with a color-scale utility. Semantic tokens are defined in packages/design-library/src/tokens.css and switch per data-theme automatically, including velvet. See apps/web/docs/STYLE_GUIDE.md.",
        },
      ],
    },
  },
]);

export default eslintConfig;
