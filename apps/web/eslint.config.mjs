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
      // Flag `dark:` paired with any color-scale utility — including
      // compound variants like `dark:hover:bg-moss-700` and Tailwind's
      // default palettes (`dark:text-red-400`, `dark:bg-sky-950`). The
      // `dark:` custom-variant in packages/design-library/src/tokens.css
      // only matches [data-theme=dark] — NOT [data-theme=velvet] — so
      // paired utilities silently break velvet contrast regardless of
      // which color scale they use. Use semantic tokens (--surface-*,
      // --content-*, --border-*) instead.
      //
      // Regex breakdown:
      //   \bdark:           — `dark:` variant prefix
      //   (\w+:)*           — optional intermediate variants
      //                       (hover:, focus:, motion-safe:, etc.)
      //   <prop>-           — utility prefix (bg, text, border, …)
      //   [a-z]+-\d+        — any color name + numeric shade
      //                       (matches in-repo scales like moss-700
      //                       and Tailwind defaults like red-400 / sky-950)
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/\\bdark:(\\w+:)*(bg|text|border|divide|ring|fill|stroke|outline|decoration|placeholder|accent|caret)-[a-z]+-\\d+/]",
          message:
            "Use a semantic token (e.g. bg-[var(--surface-lift)], text-[var(--content-default)]) instead of dark: paired with a color-scale utility. Semantic tokens are defined in packages/design-library/src/tokens.css and switch per data-theme automatically, including velvet. See apps/web/docs/STYLE_GUIDE.md.",
        },
        {
          selector:
            "TemplateElement[value.raw=/\\bdark:(\\w+:)*(bg|text|border|divide|ring|fill|stroke|outline|decoration|placeholder|accent|caret)-[a-z]+-\\d+/]",
          message:
            "Use a semantic token (e.g. bg-[var(--surface-lift)], text-[var(--content-default)]) instead of dark: paired with a color-scale utility. Semantic tokens are defined in packages/design-library/src/tokens.css and switch per data-theme automatically, including velvet. See apps/web/docs/STYLE_GUIDE.md.",
        },
      ],
    },
  },
]);

export default eslintConfig;
