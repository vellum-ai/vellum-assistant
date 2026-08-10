/**
 * Unit tests for the no-compound-touch-signal ESLint rule.
 *
 * Run with: `bun test eslint-rules/no-compound-touch-signal.test.mjs`
 *
 * The rule reads the on-disk allow-list at `.touch-signal-allowlist.json`.
 * These tests use a synthetic path that is NOT in it, so any compound import
 * fires, plus a real allow-listed path (budgeted at one use) to prove entries
 * are honoured and that the budget is a ceiling rather than a blanket pass.
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

/** A path the allow-list does not mention, so the rule applies in full. */
const NEW_FILE = path.join(WEB_ROOT, "src", "components", "__rule-fixture.tsx");

/** A real allow-list entry, budgeted at one use. */
const GRANDFATHERED = path.join(
  WEB_ROOT,
  "src",
  "components",
  "app-nav-bar.tsx",
);

const IMPORT = `import { useTouchMobile } from "@/hooks/use-touch-mobile";`;

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
    // An unrelated export from the same module is not the compound.
    {
      filename: NEW_FILE,
      code: `import { somethingElse } from "@/hooks/use-touch-mobile";`,
    },
    // A grandfathered file stays green inside its budget.
    {
      filename: GRANDFATHERED,
      code: `${IMPORT}\nconst a = useTouchMobile();`,
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
    // With ignoreAllowlist the audit script counts references, and a file
    // with an import but no reference contributes nothing.
    {
      filename: GRANDFATHERED,
      options: [{ ignoreAllowlist: true }],
      code: IMPORT,
    },
  ],
  invalid: [
    // A new file reaching for the hook.
    {
      filename: NEW_FILE,
      code: IMPORT,
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
    // Nor an extension.
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
    // A namespace import cannot launder it.
    {
      filename: NEW_FILE,
      code: `import * as touch from "@/hooks/use-touch-mobile";`,
      errors: [{ messageId: "compoundSignal" }],
    },
    // The budget is a ceiling: a grandfathered file cannot grow a second
    // branch. This is the case that makes the list freeze usages rather than
    // filenames.
    {
      filename: GRANDFATHERED,
      code: `${IMPORT}\nconst a = useTouchMobile();\nconst b = useTouchMobile();`,
      errors: [{ messageId: "extraUsage" }],
    },
    // ...and the overage is reported per excess reference, not once.
    {
      filename: GRANDFATHERED,
      code: `${IMPORT}\nconst a = useTouchMobile();\nconst b = useTouchMobile();\nconst c = useTouchMobile();`,
      errors: [{ messageId: "extraUsage" }, { messageId: "extraUsage" }],
    },
    // `ignoreAllowlist` makes the audit script see every reference, which is
    // how it recounts the real population.
    {
      filename: GRANDFATHERED,
      options: [{ ignoreAllowlist: true }],
      code: `${IMPORT}\nconst a = useTouchMobile();`,
      errors: [{ messageId: "compoundSignal" }],
    },
  ],
});
