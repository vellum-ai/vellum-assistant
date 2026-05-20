/**
 * Unit tests for the no-cross-domain-imports ESLint rule.
 *
 * Run with: `bun test eslint-rules/no-cross-domain-imports.test.mjs`
 *
 * The rule reads the on-disk allow-list at
 * `.cross-domain-allowlist.json`. These tests use file paths
 * that are NOT in the allow-list, so any cross-domain import
 * we declare here will trigger the rule.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "eslint";

import { noCrossDomainImports } from "./no-cross-domain-imports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

// Pick a domain folder that exists but where no `.test.fixture.tsx` file
// has been allow-listed. The rule resolves the owning domain from the
// file's path relative to `src/domains/`, so synthetic paths under it
// work fine without writing real files.
const fixtureUnder = (domain, name = "__rule-fixture.tsx") =>
  path.join(WEB_ROOT, "src", "domains", domain, name);

// RuleTester.run() calls describe()/it() itself, so we don't wrap.
ruleTester.run("no-cross-domain-imports", noCrossDomainImports, {
      valid: [
        // Same-domain imports are fine.
        {
          filename: fixtureUnder("account"),
          code: `import { x } from "@/domains/account/foo.js";`,
        },
        // Imports from top-level shared dirs are fine.
        {
          filename: fixtureUnder("account"),
          code: `import { useIsMobile } from "@/hooks/use-is-mobile.js";`,
        },
        // Files outside src/domains/ are not subject to the rule.
        {
          filename: path.join(WEB_ROOT, "src", "hooks", "x.ts"),
          code: `import { y } from "@/domains/account/y.js";`,
        },
      ],
      invalid: [
        {
          filename: fixtureUnder("account"),
          code: `import { y } from "@/domains/onboarding/y.js";`,
          errors: [{ messageId: "crossDomain" }],
        },
        // Catches export-from syntax too.
        {
          filename: fixtureUnder("account"),
          code: `export { y } from "@/domains/onboarding/y.js";`,
          errors: [{ messageId: "crossDomain" }],
        },
        // Catches dynamic imports.
        {
          filename: fixtureUnder("account"),
          code: `const m = import("@/domains/onboarding/y.js");`,
          errors: [{ messageId: "crossDomain" }],
        },
  ],
});
