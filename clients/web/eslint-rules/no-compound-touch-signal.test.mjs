/**
 * Unit tests for the no-compound-touch-signal ESLint rule.
 *
 * Run with: `bun test eslint-rules/no-compound-touch-signal.test.mjs`
 *
 * The rule reads the on-disk allow-list at `.touch-signal-allowlist.json`.
 * These tests use a synthetic path that is NOT in it, so any compound import
 * declared here fires, plus one real allow-listed path to prove entries are
 * honoured.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "eslint";

import { noCompoundTouchSignal } from "./no-compound-touch-signal.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

/** A path the allow-list does not mention, so the rule applies. */
const NEW_FILE = path.join(WEB_ROOT, "src", "components", "__rule-fixture.tsx");

/** A path the allow-list does mention, so the rule stands down. */
const GRANDFATHERED = path.join(WEB_ROOT, "src", "components", "app-nav-bar.tsx");

ruleTester.run("no-compound-touch-signal", noCompoundTouchSignal, {
  valid: [
    // The input axis by itself is always fine.
    {
      filename: NEW_FILE,
      code: `import { isPointerCoarse } from "@/utils/pointer";`,
    },
    // So is the size axis by itself.
    {
      filename: NEW_FILE,
      code: `import { useIsMobile } from "@/hooks/use-is-mobile";`,
    },
    // Existing call sites stay green until they migrate.
    {
      filename: GRANDFATHERED,
      code: `import { useTouchMobile } from "@/hooks/use-touch-mobile";`,
    },
    // The module that defines the compound is exempt from its own rule.
    {
      filename: path.join(WEB_ROOT, "src", "hooks", "use-touch-mobile.ts"),
      code: `export const TOUCH_MOBILE_MEDIA_QUERY = "(max-width: 767px) and (pointer: coarse)";`,
    },
    // ...and so is its test.
    {
      filename: path.join(WEB_ROOT, "src", "hooks", "use-touch-mobile.test.tsx"),
      code: `import { useTouchMobile } from "./use-touch-mobile";`,
    },
  ],
  invalid: [
    // A new file reaching for the hook.
    {
      filename: NEW_FILE,
      code: `import { useTouchMobile } from "@/hooks/use-touch-mobile";`,
      errors: [{ messageId: "compoundSignal" }],
    },
    // The raw query is the same compound wearing a different hat.
    {
      filename: NEW_FILE,
      code: `import { TOUCH_MOBILE_MEDIA_QUERY } from "@/hooks/use-touch-mobile";`,
      errors: [{ messageId: "compoundSignal" }],
    },
    // A relative import must not sidestep the alias check.
    {
      filename: NEW_FILE,
      code: `import { useTouchMobile } from "../../hooks/use-touch-mobile";`,
      errors: [{ messageId: "compoundSignal" }],
    },
    // An extension must not sidestep it either.
    {
      filename: NEW_FILE,
      code: `import { useTouchMobile } from "@/hooks/use-touch-mobile.ts";`,
      errors: [{ messageId: "compoundSignal" }],
    },
    // Both exports in one statement report separately.
    {
      filename: NEW_FILE,
      code: `import { useTouchMobile, TOUCH_MOBILE_MEDIA_QUERY } from "@/hooks/use-touch-mobile";`,
      errors: [
        { messageId: "compoundSignal" },
        { messageId: "compoundSignal" },
      ],
    },
    // A default or namespace import cannot launder it.
    {
      filename: NEW_FILE,
      code: `import * as touch from "@/hooks/use-touch-mobile";`,
      errors: [{ messageId: "compoundSignal" }],
    },
  ],
});
