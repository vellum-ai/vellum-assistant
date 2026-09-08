import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

import { noCrossDomainImports } from "./eslint-rules/no-cross-domain-imports.mjs";
import { noEmDash } from "./eslint-rules/no-em-dash.mjs";
import { noUntranslatedStrings } from "./eslint-rules/no-untranslated-strings.mjs";

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
/**
 * Typography variant names that do not exist.
 *
 * `packages/design-library/src/tokens.css` defines the typography utilities
 * via Tailwind `@utility`. The `--text-*` variables sit in a plain `:root`
 * rather than `@theme`, so Tailwind generates nothing else. A name that is
 * not declared there matches no CSS, and the element silently falls back to
 * the inherited 16px/400 instead of failing.
 *
 * The list is parsed out of `tokens.css` rather than restated, so it cannot
 * drift from the utilities that actually exist. `tokens.test.ts` takes the
 * same approach with the colour palette, for the same reason. Filtered to
 * the four scale families so unrelated `@utility` entries (for example
 * `text-optical-center`) are not treated as variants.
 *
 * Transitional. This rule guards the class-string form, which `<Typography>`
 * makes unnecessary: its `variant` prop is a typed union, so a wrong name is
 * a compile error and none of this machinery is needed. Class strings are
 * only unavoidable for variant-prefixing (`max-md:text-body-large-default`),
 * which is 7 of ~1,430 usages here. The direction is to converge on the
 * component and let this rule shrink to cover that remainder, so treat it as
 * a net under the old path rather than an endorsement of it.
 */
const TYPOGRAPHY_VARIANTS = [
  ...readFileSync(
    fileURLToPath(
      new URL(
        "../../packages/design-library/src/tokens.css",
        import.meta.url,
      ),
    ),
    "utf8",
  ).matchAll(/@utility\s+text-((?:title|body|label|chat)[a-z-]*)\s*\{/g),
].map((match) => match[1]);

if (TYPOGRAPHY_VARIANTS.length === 0) {
  throw new Error(
    "No typography utilities found in tokens.css. The parse above has drifted from the file's shape, and the unknown-variant rule would match everything.",
  );
}

/**
 * Matches `text-` + a scale family unless the whole token is a real variant.
 *
 * The exemption ends with `(?![A-Za-z0-9_-])` rather than `\b`. A word
 * boundary matches before a hyphen, so it would exempt anything merely
 * *prefixed* by a valid variant (`text-chat-foo`,
 * `text-body-small-default-typo`). The wider character class covers digit
 * and underscore suffixes too (`text-title-small2`, `text-chat_extra`),
 * which are equally undeclared. The class token has to end where the
 * variant ends.
 *
 * The leading `(?<!-)` keeps the rule off CSS custom properties. Rebinding a
 * token on one element is legitimate: the
 * `[--text-label-medium-default-weight:600]` in `camera-status-pill.tsx`
 * sets the variable the utility reads, which is how you change one facet of
 * a variant without a second utility racing it on the same property.
 * Without the lookbehind the `text-` inside `--text-…` matches.
 */
export const unknownTypographyPattern = `(?<!-)\\btext-(?!(?:${TYPOGRAPHY_VARIANTS.join("|")})(?![A-Za-z0-9_-]))(?:title|body|label|chat)[a-z-]*`;

const unknownTypographyMessage =
  "This is not a real typography variant, so it matches no CSS and the element falls back to the inherited 16px/400. Use one of: " +
  TYPOGRAPHY_VARIANTS.map((v) => `text-${v}`).join(", ") +
  '. Prefer <Typography variant="…"> so the name is checked by the compiler.';

const unknownTypographyRules = [
  {
    selector: `Literal[value=/${unknownTypographyPattern}/]`,
    message: unknownTypographyMessage,
  },
  {
    selector: `TemplateElement[value.raw=/${unknownTypographyPattern}/]`,
    message: unknownTypographyMessage,
  },
];

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
 * Raw `/v1` fetch ban — the generated HeyAPI client is the only
 * transport for API paths. A raw `fetch("/v1/...")` skips the auth
 * interceptors on the generated singleton, so the request silently
 * ships without the session token / CSRF headers.
 */
const rawApiFetchMessage =
  "Raw fetch to /v1 bypasses the generated client's auth interceptors (session token/CSRF) — use the generated SDK function; if the endpoint has no generated type, it's missing from platform.yaml (tag it with PLATFORM_API_CLIENT_EXTENSION in the platform repo).";

const rawApiFetchRules = [
  // fetch("/v1/...") — string-literal first argument.
  {
    selector:
      "CallExpression[callee.name='fetch'][arguments.0.value=/^\\/v1\\//]",
    message: rawApiFetchMessage,
  },
  // fetch(`/v1/...`) — template literal starting with /v1/.
  {
    selector:
      "CallExpression[callee.name='fetch'][arguments.0.quasis.0.value.raw=/^\\/v1\\//]",
    message: rawApiFetchMessage,
  },
  // window.fetch("/v1/...") / globalThis.fetch("/v1/...").
  {
    selector:
      "CallExpression[callee.object.name=/^(window|globalThis)$/][callee.property.name='fetch'][arguments.0.value=/^\\/v1\\//]",
    message: rawApiFetchMessage,
  },
  // window.fetch(`/v1/...`) / globalThis.fetch(`/v1/...`).
  {
    selector:
      "CallExpression[callee.object.name=/^(window|globalThis)$/][callee.property.name='fetch'][arguments.0.quasis.0.value.raw=/^\\/v1\\//]",
    message: rawApiFetchMessage,
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

/**
 * Paths where user-facing copy must come from a translation catalog.
 *
 * Covers all of `src/` (generated excluded via `globalIgnores`). Entries are
 * globs relative to `clients/web/`. Never shrink this list to silence a
 * violation; fix the copy or add an eslint-disable with a reason.
 */
const i18nEnforcedPaths = ["src/**/*.{ts,tsx}"];

/**
 * Paths where em dashes are enforced. See root `AGENTS.md`, "Em Dashes".
 *
 * Deliberately short. `src/` carries roughly 8,000 pre-existing em dashes
 * across some 1,500 files, and `AGENTS.md` says existing text is not swept
 * retroactively, so this list holds only what is already clean or was cleaned
 * in the same commit that added it. Entries are globs relative to
 * `clients/web/`.
 *
 * To enroll an area: fix its em dashes, add the glob, run `bun run lint` until
 * it is quiet. Never add a path with violations still in it.
 */
const emDashEnforcedPaths = [
  "src/i18n/**/*.{ts,tsx}",
  "src/domains/terminal/**/*.{ts,tsx}",
  "src/domains/chat/channel-sidecar/**/*.{ts,tsx}",
  // File-scoped rather than the whole `surfaces/` directory, which carries
  // pre-existing em dashes that must not be swept retroactively.
  "src/domains/chat/components/surfaces/watch-retro-surface.tsx",
  "src/domains/chat/components/surfaces/watch-retro-surface.test.tsx",
];

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  globalIgnores(["dist/**", "src/generated/**", "storybook-static/**"]),
  {
    plugins: {
      local: {
        rules: {
          "no-cross-domain-imports": noCrossDomainImports,
          "no-em-dash": noEmDash,
          "no-untranslated-strings": noUntranslatedStrings,
        },
      },
    },
    rules: {
      // Require braces on every control-statement body (if/else/for/
      // while/do). A braceless body is a maintenance hazard: a second
      // line added under the condition reads as guarded but always runs.
      curly: ["error", "all"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "local/no-cross-domain-imports": "error",
      "no-restricted-syntax": [
        "error",
        ...darkPairedColorScaleRules,
        ...unknownTypographyRules,
        ...universalAuthRules,
        ...rawApiFetchRules,
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
        ...unknownTypographyRules,
        ...universalAuthRules,
        ...rawApiFetchRules,
      ],
    },
  },
  // -----------------------------------------------------------------------
  // i18n cutover ratchet
  //
  // `local/no-untranslated-strings` covers all of `src/` (except generated).
  // Domains, hooks, and components were converted first; the remaining
  // stores/root routes followed so this glob could widen without a flood of
  // pre-existing literals. A clean lint here is not proof every user-facing
  // string is translated: the rule reads JSX, toast call sites, and
  // copy-shaped props, not every helper return value. See `docs/I18N.md`.
  //
  // Never shrink this glob to silence a violation. Fix the copy, or add an
  // eslint-disable with a reason for brand names / protocol tokens.
  {
    files: i18nEnforcedPaths,
    rules: {
      "local/no-untranslated-strings": "error",
    },
  },
  // -----------------------------------------------------------------------
  // Em dash ratchet
  //
  // Same shape as the i18n ratchet above, and scoped for the same reason:
  // repo-wide this reports thousands of pre-existing em dashes, which is how a
  // rule gets switched off instead of obeyed. See `emDashEnforcedPaths` for
  // how to enroll an area, and root `AGENTS.md` for the rule itself.
  {
    files: emDashEnforcedPaths,
    rules: {
      "local/no-em-dash": "error",
    },
  },
]);

export default eslintConfig;
