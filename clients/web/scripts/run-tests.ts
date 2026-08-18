import { runIsolatedTests } from "../../../scripts/run-isolated-tests";

await runIsolatedTests({
  cwd: import.meta.dir + "/..",
  patterns: [
    "src/**/*.test.{ts,tsx}",
    // Storybook's preview config carries logic of its own (route parameters,
    // the theme read off an untyped channel), so its suites run in CI too.
    ".storybook/**/*.test.{ts,tsx}",
    // The custom ESLint rules in `eslint-rules/` gate real conventions
    // (cross-domain imports, untranslated copy), so their RuleTester suites
    // belong in CI alongside the app's own tests.
    "eslint-rules/**/*.test.mjs",
  ],
});
