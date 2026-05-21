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
import tseslint from "typescript-eslint";

import { noCrossDomainImports } from "./no-cross-domain-imports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

// Separate tester for TypeScript-specific syntax (TSImportType).
const tsRuleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
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
    // Same-domain alias imports are fine.
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
    // Same-domain relative imports are fine.
    {
      filename: fixtureUnder("account", "sub/x.ts"),
      code: `import { y } from "../other.js";`,
    },
    // Relative imports that escape src/domains/ entirely are fine.
    {
      filename: fixtureUnder("account"),
      code: `import { y } from "../../hooks/use-thing.js";`,
    },
  ],
  invalid: [
    // Cross-domain alias subpath.
    {
      filename: fixtureUnder("account"),
      code: `import { y } from "@/domains/onboarding/y.js";`,
      errors: [{ messageId: "crossDomain" }],
    },
    // Cross-domain alias *barrel* (no trailing slash).
    {
      filename: fixtureUnder("account"),
      code: `import { y } from "@/domains/onboarding";`,
      errors: [{ messageId: "crossDomain" }],
    },
    // Cross-domain side-effect import.
    {
      filename: fixtureUnder("account"),
      code: `import "@/domains/onboarding/setup.js";`,
      errors: [{ messageId: "crossDomain" }],
    },
    // Cross-domain export-from.
    {
      filename: fixtureUnder("account"),
      code: `export { y } from "@/domains/onboarding/y.js";`,
      errors: [{ messageId: "crossDomain" }],
    },
    // Cross-domain `export * from`.
    {
      filename: fixtureUnder("account"),
      code: `export * from "@/domains/onboarding/y.js";`,
      errors: [{ messageId: "crossDomain" }],
    },
    // Cross-domain dynamic import.
    {
      filename: fixtureUnder("account"),
      code: `const m = import("@/domains/onboarding/y.js");`,
      errors: [{ messageId: "crossDomain" }],
    },
    // Cross-domain via *relative* path (resolved against importer).
    {
      filename: fixtureUnder("account"),
      code: `import { y } from "../onboarding/y.js";`,
      errors: [{ messageId: "crossDomain" }],
    },
  ],
});

// TSImportType is only parsed by the TS parser, so it gets its own tester.
tsRuleTester.run("no-cross-domain-imports (TSImportType)", noCrossDomainImports, {
  valid: [
    // Same-domain inline type query is fine.
    {
      filename: fixtureUnder("account"),
      code: `type T = import("@/domains/account/foo.js").Foo;`,
    },
  ],
  invalid: [
    // Cross-domain inline type query is a violation.
    {
      filename: fixtureUnder("account"),
      code: `type T = import("@/domains/onboarding/foo.js").Foo;`,
      errors: [{ messageId: "crossDomain" }],
    },
  ],
});
