import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

import { noCrossDomainImports } from "./eslint-rules/no-cross-domain-imports.mjs";

// ---------------------------------------------------------------------------
// no-restricted-syntax rule sets
//
// `no-restricted-syntax` is an array, and ESLint flat config REPLACES the
// array when redeclared. So path-scoped overrides have to restate every rule
// they want to keep. We split the rules into named groups to make the
// overrides readable.
// ---------------------------------------------------------------------------

/**
 * `dark:`-paired color-scale utilities — protects the velvet theme.
 *
 * The `dark:` custom variant only matches `[data-theme=dark]`, not
 * `[data-theme=velvet]`, so any paired utility silently breaks velvet
 * contrast. Use semantic tokens (`--surface-*`, `--content-*`,
 * `--border-*`) instead. See `clients/web/docs/STYLE_GUIDE.md`.
 */
const darkPairedColorScaleRules = [
  {
    selector:
      "Literal[value=/\\bdark:(\\w+:)*(bg|text|border|divide|ring|fill|stroke|outline|decoration|placeholder|accent|caret)-[a-z]+-\\d+/]",
    message:
      "Use a semantic token (e.g. bg-[var(--surface-lift)], text-[var(--content-default)]) instead of dark: paired with a color-scale utility. Semantic tokens are defined in packages/design-library/src/tokens.css and switch per data-theme automatically, including velvet. See clients/web/docs/STYLE_GUIDE.md.",
  },
  {
    selector:
      "TemplateElement[value.raw=/\\bdark:(\\w+:)*(bg|text|border|divide|ring|fill|stroke|outline|decoration|placeholder|accent|caret)-[a-z]+-\\d+/]",
    message:
      "Use a semantic token (e.g. bg-[var(--surface-lift)], text-[var(--content-default)]) instead of dark: paired with a color-scale utility. Semantic tokens are defined in packages/design-library/src/tokens.css and switch per data-theme automatically, including velvet. See clients/web/docs/STYLE_GUIDE.md.",
  },
];

/**
 * Universal auth-boundary rules — apply EVERYWHERE, including inside
 * `lib/auth/` and `lib/api-interceptors.ts`. These guardrails have no
 * legitimate exception:
 *
 * - A duplicate HeyAPI client instance inside `lib/auth/` would silently
 *   bypass the interceptors just as badly as one outside it.
 * - Tokens, credentials, and secrets do not belong in JS-readable
 *   storage anywhere, regardless of which module is doing the writing.
 *
 * See `clients/web/docs/CONVENTIONS.md` → "Authentication".
 */
const universalAuthRules = [
  // No new `createClient(...)` outside generated/. There must be exactly
  // one HeyAPI client instance per app — the generated singleton. Hand-
  // written wrappers import `client` from `@/generated/api/client.gen`.
  // Note: `src/generated/**` is globally ignored, so this effectively
  // means "no createClient anywhere we lint".
  {
    selector: "CallExpression[callee.name='createClient']",
    message:
      'Do not call createClient(...) outside src/generated/. Import the singleton: `import { client } from "@/generated/api/client.gen"`. A second instance does not inherit the auth-header interceptors and silently sends unauthenticated requests.',
  },

  // No `localStorage.setItem(key, …)` / `sessionStorage.setItem(key, …)`
  // where the literal key looks like a token / credential / session /
  // secret / JWT / bearer / password / api-key. Browser-readable storage
  // is XSS-exposed and the wrong place for any of those — even inside
  // auth code, which should use HttpOnly cookies or platform-secure
  // storage instead.
  {
    selector:
      "CallExpression[callee.object.name='localStorage'][callee.property.name='setItem'][arguments.0.value=/(?:token|credential|secret|jwt|bearer|password|api[_-]?key|session[_-]?token)/i]",
    message:
      "Do not write tokens, credentials, or session-like values to localStorage — JS-readable storage is XSS-exposed. Use HttpOnly cookies (issued by the server, stored by the browser) or platform-secure storage (Keychain, Electron safeStorage) instead.",
  },
  {
    selector:
      "CallExpression[callee.object.name='sessionStorage'][callee.property.name='setItem'][arguments.0.value=/(?:token|credential|secret|jwt|bearer|password|api[_-]?key|session[_-]?token)/i]",
    message:
      "Do not write tokens, credentials, or session-like values to sessionStorage — JS-readable storage is XSS-exposed. Use HttpOnly cookies (issued by the server, stored by the browser) or platform-secure storage (Keychain, Electron safeStorage) instead.",
  },
  // Same patterns via `window.localStorage` / `window.sessionStorage`.
  {
    selector:
      "CallExpression[callee.object.object.name='window'][callee.object.property.name='localStorage'][callee.property.name='setItem'][arguments.0.value=/(?:token|credential|secret|jwt|bearer|password|api[_-]?key|session[_-]?token)/i]",
    message:
      "Do not write tokens, credentials, or session-like values to localStorage — JS-readable storage is XSS-exposed.",
  },
  {
    selector:
      "CallExpression[callee.object.object.name='window'][callee.object.property.name='sessionStorage'][callee.property.name='setItem'][arguments.0.value=/(?:token|credential|secret|jwt|bearer|password|api[_-]?key|session[_-]?token)/i]",
    message:
      "Do not write tokens, credentials, or session-like values to sessionStorage — JS-readable storage is XSS-exposed.",
  },
];

/**
 * Header-literal rules — apply OUTSIDE the auth boundary only.
 *
 * The `lib/auth/` directory and `lib/api-interceptors.ts` are the only
 * places that legitimately set these headers. Restricting them to that
 * boundary keeps auth-header drift from spreading back across the
 * codebase.
 *
 * Path-scoped via the override block below.
 */
const headerLiteralRules = [
  // No literal `X-Session-Token` strings outside the auth/interceptor
  // surface. It is the native-client session auth header; keep it centralized.
  {
    selector: "Literal[value='X-Session-Token']",
    message:
      "Do not set the X-Session-Token header outside src/lib/auth/ or src/lib/api-interceptors.ts. It is the native-client session auth header and is centralized in the auth interceptor.",
  },

  // No new literal `X-CSRFToken` strings outside the auth/interceptor
  // surface. CSRF protection is being centralized.
  {
    selector: "Literal[value='X-CSRFToken']",
    message:
      "Do not introduce new uses of the X-CSRFToken header outside src/lib/auth/ or src/lib/api-interceptors.ts. CSRF is centralized in the auth interceptor.",
  },

  // No new literal `Vellum-Organization-Id` strings outside the
  // auth/interceptor surface. The active-org context belongs in one
  // place, not handcrafted across call sites.
  {
    selector: "Literal[value='Vellum-Organization-Id']",
    message:
      "Do not introduce new uses of the Vellum-Organization-Id header outside src/lib/auth/. Only the central interceptor should be reading or setting this header.",
  },
];

// Paths that legitimately produce/consume the auth headers.
// Exempt from `headerLiteralRules` but still subject to
// `universalAuthRules` and `darkPairedColorScaleRules`.
//
// `api-interceptors.test.ts` lives inside the auth boundary by design — it
// exercises the central interceptor and must assert on the exact header
// names. Centralizing the test next to the implementation it tests does
// not weaken the guardrail.
const authBoundaryAllowedPaths = [
  "src/lib/auth/**",
  "src/lib/api-interceptors.ts",
  "src/lib/api-interceptors.test.ts",
];

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  globalIgnores(["dist/**", "src/generated/**", "storybook-static/**"]),
  {
    plugins: {
      local: { rules: { "no-cross-domain-imports": noCrossDomainImports } },
    },
    rules: {
      // Require braces on every control-statement body (if/else/for/
      // while/do). A braceless body is a maintenance hazard: a second
      // line added under the condition reads as guarded but always runs.
      curly: ["warn", "all"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "local/no-cross-domain-imports": "error",
      "no-restricted-syntax": [
        "error",
        ...darkPairedColorScaleRules,
        ...universalAuthRules,
        ...headerLiteralRules,
      ],

      // -----------------------------------------------------------------------
      // eslint-plugin-react-hooks overrides
      //
      // The `recommended` preset enables 16 rules from the React team.
      // Rules with zero existing violations are left at their recommended
      // level. Rules with many pre-existing violations are relaxed here
      // and tracked for future enablement.
      //
      // See https://react.dev/reference/eslint-plugin-react-hooks
      // -----------------------------------------------------------------------

      // 69 pre-existing violations — synchronous setState inside
      // useEffect bodies. Many are legitimate "reset state when key
      // changes" patterns that require restructuring (React 19 key-based
      // reset, useSyncExternalStore, or effect → event handler lift).
      "react-hooks/set-state-in-effect": "off",

      // 34 pre-existing violations — many intentional (mount-only
      // effects, stable-ref deps). Warn gives visibility in editor
      // without blocking CI while the codebase is incrementally fixed.
      "react-hooks/exhaustive-deps": "warn",

      // 11 pre-existing violations — React Compiler can't preserve
      // existing manual memoization because inferred deps differ from
      // specified deps. Requires case-by-case analysis.
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
  // Override: files inside the auth boundary may use the auth-header
  // literals. The `createClient` ban and the storage-of-credentials
  // bans still apply — they have no legitimate exception anywhere.
  // Restate `no-restricted-syntax` with everything EXCEPT the header
  // literal rules, since flat-config replaces the array on override.
  {
    files: authBoundaryAllowedPaths,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...darkPairedColorScaleRules,
        ...universalAuthRules,
      ],
    },
  },
]);

export default eslintConfig;
